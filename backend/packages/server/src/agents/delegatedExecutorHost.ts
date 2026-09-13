import type {
  AgentContextRecorder,
  Clock,
  DelegatedExecutorDeps,
  DelegatedExecutorRegistry,
  DelegatedFetch,
  Logger,
  ResolveRunRepoContext,
  TaskRepository,
  ToolSecretResolver,
  UrlSafetyPolicy,
} from '@cat-factory/kernel'
import type { AgentKindRegistry } from '@cat-factory/agents'
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
  resolveRepoOrigin?: ResolveRepoOrigin
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
   */
  urlSafetyPolicy?: UrlSafetyPolicy
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
    fetchImpl: options.fetchImpl ?? (globalThis.fetch as unknown as DelegatedFetch),
    ...(options.urlSafetyPolicy ? { urlSafetyPolicy: options.urlSafetyPolicy } : {}),
    ...(options.resolveRunRepoContext
      ? { repoFiles: repoFilesResolver(options.resolveRunRepoContext) }
      : {}),
  }
  return new DelegatedAgentExecutor({
    delegatedExecutorRegistry: options.delegatedExecutorRegistry,
    agentKindRegistry: options.agentKindRegistry,
    resolveRepoTarget: options.resolveRepoTarget,
    ...(options.resolveRepoOrigin ? { resolveRepoOrigin: options.resolveRepoOrigin } : {}),
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
