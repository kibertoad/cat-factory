import type { AgentRunContext } from '@cat-factory/kernel'
import type {
  AgentContextFile,
  AgentContextFragment,
  AgentContextRecorder,
  Logger,
  RecordAgentContextInput,
} from '@cat-factory/kernel'
import { runBestEffort } from '@cat-factory/kernel'
import type { DispatchToolServers } from '@cat-factory/contracts'

// The agent-context observability SNAPSHOT: composing the redacted record of everything one
// dispatch handed its agent. Extracted from `ContainerAgentExecutor` because it is a distinct
// concern from dispatching and polling container jobs — it is a pure projection whose whole
// job is deciding what may be persisted, and it is the one place the allow-list lives.
//
// The rule the whole file exists to enforce: this is an ALLOW-LIST, never a deny-list. It copies
// the composed prompts, the folded-in fragment bodies and the injected context files, plus a
// handful of structural fields — and NEVER a credential (the GitHub token, the proxy session
// token, a leased subscription token, or a clone/environment URL that embeds one).

/**
 * Strip any embedded `user:pass@` userinfo from a URL before it is stored in an
 * observability snapshot. The allow-list promises "never a credential-bearing URL", but
 * the injected-doc URLs and a tester's ephemeral `environmentUrl` are operator-supplied
 * and could carry credentials in their userinfo, so defang them here. Non-URL strings
 * (and URLs with no userinfo) pass through unchanged.
 */
export function stripUrlCredentials(value: string): string {
  if (!value) return value
  try {
    const url = new URL(value)
    if (!url.username && !url.password) return value
    url.username = ''
    url.password = ''
    return url.toString()
  } catch {
    return value
  }
}

/**
 * Redact credential-bearing URLs from the tester's `infra` spec before it is stored.
 * An `ephemeral` run carries the provisioned `environmentUrl`; the env's access
 * credentials live on a separate field that is never copied, but the URL itself is
 * operator-mapped and could embed userinfo, so strip it. Returns the value untouched
 * when it is not an `infra` object.
 */
function redactInfra(infra: unknown): unknown {
  if (!infra || typeof infra !== 'object' || Array.isArray(infra)) return infra
  const copy = { ...(infra as Record<string, unknown>) }
  if (typeof copy.environmentUrl === 'string') {
    copy.environmentUrl = stripUrlCredentials(copy.environmentUrl)
  }
  return copy
}

/**
 * Build the redacted agent-context snapshot from a dispatched job body + run context.
 * Deliberately an ALLOW-LIST: it copies the composed prompts, the folded-in fragment
 * bodies and the injected context files, plus a handful of structural fields — and
 * NEVER any credential (the GitHub token, the proxy session token, a leased
 * subscription token, or the clone/environment URL that embeds them).
 */
export function buildAgentContextRecord(
  context: AgentRunContext,
  body: Record<string, unknown>,
  model: string,
  ids: {
    workspaceId: string
    executionId: string
    /**
     * The step's own tool-server record, for the DEPRECATED `extras` copy below. Passed already
     * projected rather than re-derived here, so the snapshot cannot state something the step does
     * not: `stepToolServerRecord` stays the one producer of both.
     */
    toolServers?: DispatchToolServers
  },
): RecordAgentContextInput {
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  const repo = (body.repo ?? {}) as Record<string, unknown>
  const contextFiles = Array.isArray(body.contextFiles)
    ? (body.contextFiles as unknown[]).map((f): AgentContextFile => {
        const file = (f ?? {}) as Record<string, unknown>
        return {
          path: str(file.path),
          title: str(file.title),
          url: stripUrlCredentials(str(file.url)),
          content: str(file.content),
        }
      })
    : []
  const fragments: AgentContextFragment[] = (context.block.resolvedFragments ?? []).map((fr) => ({
    id: fr.id,
    body: fr.body,
  }))
  return {
    workspaceId: ids.workspaceId,
    executionId: ids.executionId,
    agentKind: context.agentKind,
    stepIndex: context.stepIndex,
    model,
    // Record the harness the body actually carried; don't guess. A body without an
    // explicit harness records `null` rather than mislabelling a codex / claude-code
    // dispatch as `pi`.
    harness: typeof body.harness === 'string' ? body.harness : null,
    systemPrompt: str(body.systemPrompt),
    userPrompt: str(body.userPrompt),
    fragments,
    contextFiles,
    extras: {
      pipelineName: context.pipelineName,
      mode: body.mode,
      repo: { owner: str(repo.owner), name: str(repo.name), baseBranch: str(repo.baseBranch) },
      branch: body.branch,
      serviceDirectory: repo.serviceDirectory,
      webSearch: body.webSearch ?? false,
      infra: redactInfra(body.infra),
      decisions: context.decisions,
      // DEPRECATED, and served only until the window in `backend/docs/public-api.md` closes: the
      // authority for this is now `PipelineStep.toolServers`, reachable on the same public surface
      // as `steps[].toolServers` of `GET /api/v1/debug/runs/:runId` — not gated behind prompt
      // recording, and not pruned on the telemetry retention window, which is why it moved.
      // Projected from the step's own record rather than recomputed, so the two cannot disagree
      // while both are served. The shapes are the ones that shipped (ids, and id-plus-reason), and
      // an empty list is omitted exactly as it was.
      ...(ids.toolServers?.wired.length
        ? { toolServers: ids.toolServers.wired.map((server) => server.id) }
        : {}),
      ...(ids.toolServers?.unavailable.length
        ? {
            unavailableToolServers: ids.toolServers.unavailable.map((server) => ({
              id: server.id,
              reason: server.reason,
            })),
          }
        : {}),
      // The generative binary integrations this dispatch ran with: ids and content types only.
      // When a generation step's output is wrong or missing, "which integration was it even
      // pointed at" is the first question, and the step's own selection can be edited after the
      // run. The credential KEY name is deliberately not copied: it identifies nothing about the
      // run and this is a body a human reads for debugging.
      ...(context.binaryGenerators?.length
        ? {
            binaryGenerators: context.binaryGenerators.map((generator) => ({
              id: generator.id,
              modalities: generator.modalities,
            })),
          }
        : {}),
      // The catalog services this dispatch could authenticate to, by SERVICE ID only. Same
      // question one layer over: an upload that never happened is first diagnosed by asking
      // whether the step was given a way to authenticate at all. The credential key names are
      // deliberately not copied, for the reason they are not copied above: they identify nothing
      // about the run, and this is a body a human reads for debugging.
      ...(context.foundationalCredentials?.length
        ? {
            authenticatedServices: context.foundationalCredentials.map((service) => service.id),
          }
        : {}),
      ...(context.revision
        ? { revision: { feedback: context.revision.feedback, hadPriorProposal: true } }
        : {}),
    },
  }
}

/**
 * File one dispatch's snapshot, if the deployment wired a recorder at all.
 *
 * Lives here rather than at the dispatch site because it is the same concern as the projection
 * above: this module owns what may be persisted about a dispatch AND how it is filed, so the
 * executor keeps one call rather than the allow-list's rationale spread across two files.
 *
 * AWAITED, not fire-and-forget. It runs AFTER the container job is already dispatched, so it is
 * off the container's critical path: the only thing it delays is the driver's return of the
 * handle, which then sleeps before its first poll regardless. A bare `void promise` here would be
 * silently dropped on the Worker, where `startJob` runs inside a Cloudflare Workflow step and the
 * isolate hibernates on the next durable `step.sleep` before an un-awaited insert can land (see
 * `http/waitUntil.ts`), so the snapshot would stop recording on the primary runtime. The
 * best-effort swallow guarantees a recorder failure still never breaks a dispatch.
 */
export async function recordAgentContextSnapshot(
  recorder: AgentContextRecorder | undefined,
  logger: Logger,
  input: {
    context: AgentRunContext
    body: Record<string, unknown>
    model: string
    workspaceId: string
    executionId: string
    toolServers?: DispatchToolServers
  },
): Promise<void> {
  if (!recorder) return
  const { context, body, model, ...ids } = input
  await runBestEffort(logger, 'containerAgent.recordAgentContext', () =>
    recorder.record(buildAgentContextRecord(context, body, model, ids)),
  )
}

/**
 * The same snapshot for a REPO-BOOTSTRAP dispatch, which has no {@link AgentRunContext}.
 *
 * A bootstrap runs before the service it creates exists, so there is no block, no pipeline and
 * no resolved fragments to fold. There IS a composed system prompt, a brief a human wrote,
 * and a repository the agent was pointed at, which is the whole of what "what was this agent
 * given" means for this run. Left unrecorded (as it was), a bootstrap is the one agent run whose
 * Provided-context tab is empty with nothing on screen to say whether that is an opt-out, an
 * unwired sink, or a dispatch that never filed one.
 *
 * It lives here rather than beside the bootstrapper for the reason stated at the top of this
 * file: this module is the ONE place the persistence allow-list is decided, and a second builder
 * elsewhere is how a second (looser) list gets written.
 */
export function buildBootstrapContextRecord(input: {
  body: Record<string, unknown>
  model: string
  agentKind: string
  workspaceId: string
  executionId: string
  /** The run's own step this dispatch IS, so a snapshot keys to a step like every other one. */
  stepIndex: number
}): RecordAgentContextInput {
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  const body = input.body
  const repo = (body.repo ?? {}) as Record<string, unknown>
  const bootstrap = (body.bootstrap ?? {}) as Record<string, unknown>
  const target = (bootstrap.target ?? {}) as Record<string, unknown>
  return {
    workspaceId: input.workspaceId,
    executionId: input.executionId,
    agentKind: input.agentKind,
    stepIndex: input.stepIndex,
    model: input.model,
    // Recorded as the body carries it, exactly as above: bootstrap sends no explicit harness,
    // and inventing one here would make this the one snapshot that states rather than records.
    harness: typeof body.harness === 'string' ? body.harness : null,
    systemPrompt: str(body.systemPrompt),
    userPrompt: str(body.userPrompt),
    // A bootstrap folds no best-practice fragments and injects no `.cat-context` files: the
    // empty lists are the honest projection, not a gap.
    fragments: [],
    contextFiles: [],
    extras: {
      mode: body.mode,
      // Clone SOURCE (owner/name/branch only, never the clone URL, which is where a token
      // would ride), the subdirectory a monorepo run is confined to, and the push TARGET a
      // new-repo run force-pushes to. Between them they answer "which repositories was this
      // agent pointed at", which is the first question a wrong bootstrap raises.
      repo: { owner: str(repo.owner), name: str(repo.name), baseBranch: str(repo.baseBranch) },
      branch: body.branch,
      serviceDirectory: repo.serviceDirectory,
      ...(target.owner || target.name
        ? { bootstrapTarget: { owner: str(target.owner), name: str(target.name) } }
        : {}),
      ...(body.newBranch ? { newBranch: body.newBranch } : {}),
    },
  }
}

/** File a bootstrap dispatch's snapshot. The best-effort sibling of the function above. */
export async function recordBootstrapContextSnapshot(
  recorder: AgentContextRecorder | undefined,
  logger: Logger,
  input: Parameters<typeof buildBootstrapContextRecord>[0],
): Promise<void> {
  if (!recorder) return
  await runBestEffort(logger, 'bootstrap.recordAgentContext', () =>
    recorder.record(buildBootstrapContextRecord(input)),
  )
}
