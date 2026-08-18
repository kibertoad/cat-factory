import type {
  Block,
  Clock,
  GateContext,
  GateDefinition,
  GateRegistry,
  JudgeContext,
  Logger,
  ProviderRegistry,
  RaiseNotificationInput,
  RunInitiatorScope,
} from '@cat-factory/kernel'

// ---------------------------------------------------------------------------
// The engine seams handed to DEPLOYMENT-REGISTERED extensions at registry-build time.
//
// Two extension families take a context object — polling gates ({@link GateContext}) and judges
// ({@link JudgeContext}) — and both want the SAME minimal surface: the clock, a block read, the
// run-initiator scope, a notification raiser, and the typed provider registry. Building them
// beside each other (rather than as two near-identical private methods on the dispatcher) is what
// keeps them honest: adding a seam to one and forgetting the other is how an extension family
// quietly ends up second-class.
//
// Extracted from `RunDispatcher` as a cohesive collaborator per the file-size rule (split along a
// seam, never grow the ratchet) — the same shape as the `DeployerStepController` /
// `RunRepoOpsController` extractions: a small deps object of bound call-backs, and a thin
// delegate left on the dispatcher.
// ---------------------------------------------------------------------------

/** The engine collaborators both extension contexts close over. */
export interface ExtensionContextDeps {
  clock: Clock
  /** The dispatcher's scoped logger, so an extension's best-effort work names its own failures. */
  logger: Logger
  getBlock(workspaceId: string, blockId: string): Promise<Block | null>
  runInitiatorScope: RunInitiatorScope
  /** Raise a human-actionable card; a no-op when no notification service is wired. */
  raiseNotification(workspaceId: string, input: RaiseNotificationInput): Promise<void>
  /**
   * The app-owned provider registry the facade injected. A gate/judge reaches its
   * deployment-wired provider through THIS instance — never a module global; the engine just
   * forwards.
   */
  providerRegistry: ProviderRegistry
}

/** The shared engine seams handed to a deployment-registered gate's factory. */
export function makeGateContext(deps: ExtensionContextDeps): GateContext {
  return {
    clock: deps.clock,
    logger: deps.logger,
    getBlock: (workspaceId, blockId) => deps.getBlock(workspaceId, blockId),
    runInitiatorScope: deps.runInitiatorScope,
    raiseNotification: (workspaceId, input) => deps.raiseNotification(workspaceId, input),
    getProvider: (token) => deps.providerRegistry.get(token),
    requireProvider: (token) => deps.providerRegistry.require(token),
    isProviderWired: (token) => deps.providerRegistry.isWired(token),
  }
}

/**
 * The shared engine seams handed to a deployment-registered JUDGE's factory — deliberately the
 * same minimal surface as a gate's. The engine keeps owning the assessment dispatch, threshold
 * resolution, persistence and the state machine, exactly as it keeps owning a gate's dispatch,
 * budget and parking.
 */
export function makeJudgeContext(deps: ExtensionContextDeps): JudgeContext {
  return makeGateContext(deps)
}

/**
 * Build the engine's per-kind gate map from the app-owned registry.
 *
 * The built-in gate suite (ci / conflicts / post-release-health / …) is NOT inline: it ships as
 * `@cat-factory/gates`, installed into the `GateRegistry` the facade threads through
 * `CoreDependencies` (the dogfood — the platform's own gates register through the SAME public
 * seam as anyone's). The engine merely builds whatever gates the facade registered. A facade that
 * forgot to call `registerBuiltinGates(...)` then has no gates and those steps fail — which the
 * cross-runtime conformance suite catches.
 */
export function buildGateMap(
  registry: GateRegistry,
  ctx: GateContext,
): Map<string, GateDefinition> {
  const map = new Map<string, GateDefinition>()
  for (const { kind, factory } of registry.factories()) map.set(kind, factory(ctx))
  return map
}
