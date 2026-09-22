import type {
  AgentContextRecorder,
  Clock,
  DelegatedExecutorDeps,
  DelegatedExecutorRegistry,
  DelegatedFetch,
  DelegatedFetchResponse,
  Logger,
  ResolveRunRepoContext,
  TaskRepository,
  ToolSecretResolver,
  UrlSafetyPolicy,
} from '@cat-factory/kernel'
import type { AgentKindRegistry } from '@cat-factory/agents'
import { UnavailableError } from '@cat-factory/kernel'
import {
  assertSafePublicUrl,
  readCappedText,
  safeFetch,
  DEFAULT_MAX_REDIRECTS,
} from '@cat-factory/integrations'
import { DelegatedAgentExecutor } from './DelegatedAgentExecutor.js'
import type { ResolveRepoOrigin, ResolveRepoTarget } from './repoTargeting.js'

// ---------------------------------------------------------------------------
// The ONE place a facade builds the delegated arm.
//
// It exists so the two facades cannot wire it differently, which is the failure the
// runtime-symmetry rule exists to prevent and the one this seam is most exposed to: a deployment's
// executor working on Cloudflare and silently reaching an empty credential resolver on Node would
// look, from the board, like the external system rejecting every call.
// ---------------------------------------------------------------------------

/** What a facade supplies to stand the delegated arm up. */
export interface DelegatedExecutorHostOptions {
  delegatedExecutorRegistry: DelegatedExecutorRegistry
  agentKindRegistry: AgentKindRegistry
  resolveRepoTarget: ResolveRepoTarget
  /**
   * Where a repo is reached: the clone URL plus the VCS provider.
   *
   * REQUIRED, for the reason `urlSafetyPolicy` below is: optional, the Worker facade simply did
   * not pass it, and every delegated brief on that facade named a `https://github.com/...` clone
   * URL, including for repositories on the deployment's own GitLab. A facade with nothing to
   * resolve passes `githubRepoOrigin` by name.
   */
  resolveRepoOrigin: ResolveRepoOrigin
  /**
   * The engine's checkout-free repo binding, re-used as the `repoFiles` an executor may stage its
   * own context layer through. The SAME seam a registered kind's pre/post-ops run over, rather
   * than a second binding: an executor writing `.cat-context/` onto the work branch and a preOp
   * writing it are the same operation, and two bindings would be two caches and two head memos.
   */
  resolveRunRepoContext?: ResolveRunRepoContext
  taskRepository?: TaskRepository
  resolveToolSecrets?: ToolSecretResolver
  agentContextObservability?: AgentContextRecorder
  /**
   * The deployment's outbound-URL policy. The SAME one the notification-webhook sender is held to,
   * because an executor is an outbound HTTP surface the deployment configured and a second set of
   * SSRF rules is a set nobody maintains.
   *
   * REQUIRED, though its value may be `undefined` (which means the strict public-https default).
   * Optional, it was declared here, declared on the kernel port, documented on both, and passed by
   * neither facade: every registered executor was built with an SSRF control that existed only in
   * the types. A required field makes forgetting it a typecheck failure instead.
   *
   * It is ENFORCED here rather than handed to each executor, by wrapping the fetch they are all
   * built over (see {@link policyCheckedFetch}). An executor is deployment-authored code, and a
   * control every author has to remember to apply is the same control that existed only in the
   * types.
   */
  urlSafetyPolicy: UrlSafetyPolicy | undefined
  /** The runtime's fetch. Defaults to the global one, which both runtimes provide. */
  fetchImpl?: DelegatedFetch
  logger: Logger
  clock: Clock
}

/**
 * Build the delegated arm for the composite executor.
 *
 * Built UNCONDITIONALLY, even when the registry is empty. The alternative (a null arm when
 * nothing is registered) reads as an optimisation and is a trap: a MOTHERSHIP-MODE node resolves
 * its agent kinds from the mothership and its own registry can be a build behind, so "this process
 * registers none" is not the same fact as "this run has no delegated step". With the arm always
 * present, such a step is refused by name (`delegated_executor_unwired`, naming what IS
 * registered) instead of a bare "no delegated executor wired" from the composite.
 */
export function buildDelegatedAgentExecutor(
  options: DelegatedExecutorHostOptions,
): DelegatedAgentExecutor {
  const executorDeps: DelegatedExecutorDeps = {
    logger: options.logger.child({ component: 'delegatedExecutor' }),
    clock: options.clock,
    fetchImpl: policyCheckedFetch(
      options.fetchImpl ?? (globalThis.fetch as unknown as DelegatedFetch),
      options.urlSafetyPolicy,
    ),
    ...(options.resolveRunRepoContext
      ? { repoFiles: repoFilesResolver(options.resolveRunRepoContext) }
      : {}),
  }
  return new DelegatedAgentExecutor({
    delegatedExecutorRegistry: options.delegatedExecutorRegistry,
    agentKindRegistry: options.agentKindRegistry,
    resolveRepoTarget: options.resolveRepoTarget,
    resolveRepoOrigin: options.resolveRepoOrigin,
    ...(options.taskRepository ? { taskRepository: options.taskRepository } : {}),
    ...(options.resolveToolSecrets ? { resolveToolSecrets: options.resolveToolSecrets } : {}),
    ...(options.agentContextObservability
      ? { agentContextObservability: options.agentContextObservability }
      : {}),
    executorDeps,
    logger: options.logger,
    clock: options.clock,
  })
}

/** Project the engine's run-repo binding down to the narrower shape an executor is handed. */
function repoFilesResolver(
  resolveRunRepoContext: ResolveRunRepoContext,
): NonNullable<DelegatedExecutorDeps['repoFiles']> {
  return async ({ workspaceId, blockId }) => {
    const bound = await resolveRunRepoContext(workspaceId, blockId)
    return bound?.repo ?? null
  }
}

/**
 * How long one executor call may take, redirects included, before it is abandoned.
 *
 * A delegated executor's own calls are API requests (dispatch, poll, cancel), not the external
 * WORK, whose hours are bounded by the poll policy instead. Without a deadline a hung endpoint
 * holds `DelegatedAgentExecutor.pollJob` open for ever, which on Node ties up a pg-boss worker and
 * on the Worker burns the invocation: the ordinary shape of an outage, and the reason the
 * notification-webhook sender sets one against this same `safeFetch`. A caller that passes its own
 * `signal` keeps it.
 */
export const DELEGATED_REQUEST_TIMEOUT_MS = 30_000

/**
 * How much of one response body an executor may read.
 *
 * The third protection `safe-fetch` exists for, and the one a wrapper that only re-validates hops
 * leaves off. An executor is deployment-authored code reading a system's JSON, and a broken or
 * hostile endpoint answering hundreds of megabytes would otherwise be buffered whole in the
 * isolate. Generous against the real payloads (a page of Actions runs is a few hundred KB) and
 * fatal well before an OOM.
 */
export const DELEGATED_RESPONSE_MAX_BYTES = 4 * 1024 * 1024

/**
 * The fetch every registered executor is built over: the runtime's own, held to the deployment's
 * outbound-URL policy on the first URL AND on every redirect hop, given a deadline, and capped on
 * the way back.
 *
 * The SAME guard the notification-webhook sender uses, through the same `safeFetch`, because an
 * executor is the same kind of surface: an operator-supplied base URL, a credential-bearing
 * request, and a receiver free to answer 302. Re-validating each hop is the part a plain
 * scheme check at registration cannot do, and `safeFetch` additionally strips the body and the
 * credential headers when a hop crosses origins.
 *
 * All THREE of that module's protections are applied here rather than two, and for the reason the
 * policy itself is enforced here: an executor is deployment-authored code, and a control every
 * author has to remember to apply is a control that exists only in the types.
 *
 * A refused URL throws `ValidationError` out of the executor's own call, which its error path
 * reports like any other refusal from its system.
 */
function policyCheckedFetch(
  fetchImpl: DelegatedFetch,
  policy: UrlSafetyPolicy | undefined,
): DelegatedFetch {
  const assertSafe = (url: string) =>
    assertSafePublicUrl(url, {
      subject: 'Delegated executor',
      label: 'endpoint',
      ...(policy ? { policy } : {}),
    })
  const makeError = (status: number, message: string) =>
    new UnavailableError(
      `A delegated executor's request could not be completed: ${message}`,
      'delegated_executor_failed',
      { status },
    )
  return async (url, init) => {
    const response = await safeFetch(
      url,
      {
        ...((init ?? {}) as Parameters<typeof safeFetch>[1]),
        // The caller's own deadline wins where it set one; otherwise the deployment's. The port
        // declares `signal` as `unknown` (kernel compiles against no runtime's globals), so the
        // narrowing happens here, where a real `RequestInit` is being built.
        signal:
          (init?.signal as AbortSignal | undefined) ??
          AbortSignal.timeout(DELEGATED_REQUEST_TIMEOUT_MS),
      },
      assertSafe,
      makeError,
      DEFAULT_MAX_REDIRECTS,
      fetchImpl as unknown as typeof fetch,
    )
    return cappedResponse(response, makeError)
  }
}

/**
 * The response an executor sees: the real one's status and headers, with the two body readers
 * routed through the running byte cap.
 *
 * A wrapper rather than a rule each executor applies, because the port hands them only `text()`
 * and `json()` and neither can be bounded from the outside. The cap THROWS rather than truncating,
 * which is right on this path: a body that overran is not a smaller body, and a JSON reader handed
 * a prefix would parse a fault as a malformed payload.
 */
function cappedResponse(
  response: Response,
  makeError: (status: number, message: string) => Error,
): DelegatedFetchResponse {
  const read = () => readCappedText(response, DELEGATED_RESPONSE_MAX_BYTES, makeError)
  return {
    ok: response.ok,
    status: response.status,
    headers: response.headers,
    text: read,
    json: async () => JSON.parse(await read()) as unknown,
  }
}
