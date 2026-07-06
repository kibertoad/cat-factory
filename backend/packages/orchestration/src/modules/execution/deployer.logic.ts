import type { PipelineStep, ProvisionType, ServiceProvisioning } from '@cat-factory/kernel'
import { DEPLOYER_AGENT_KIND } from '@cat-factory/integrations'

/**
 * The deterministic, replay-stable job id for a `deployer` step's container-backed deploy job.
 * Mirrors the agent executor's `stepJobId`: a Workflows replay of the dispatch step reproduces
 * the SAME id, so the runner transport (idempotent per ref) re-attaches to the in-flight deploy
 * container instead of starting a duplicate. A random id (the old `idGenerator.next('deploy')`)
 * would change on a replay that threw after dispatch but before persisting `step.jobId`, leaving
 * the first container orphaned and re-applying kustomize/helm. The eviction epoch keeps each
 * re-dispatch AFTER a container eviction distinct, so a fresh job can't re-attach to the dead
 * container's already-completed job.
 */
export function deployJobId(executionId: string, epoch: number, frameId?: string): string {
  // A multi-env deploy fans out one job PER service frame (the task's own + each involved
  // service), so the frame id discriminates the otherwise-identical per-run ids. A single-frame
  // deploy passes no frame and keeps the historical `<runId>-deployer[-epoch]` shape.
  const base = `${executionId}-${DEPLOYER_AGENT_KIND}${frameId ? `-${frameId}` : ''}`
  return epoch > 0 ? `${base}-${epoch}` : base
}

/**
 * Order a multi-env deploy's target service frames PROVIDER-BEFORE-CONSUMER: a frame is emitted
 * only once every frame it CONNECTS TO (uses) that is also a target has been emitted, so a later
 * provision can be handed its already-ready peers' URLs (the cross-injection in
 * `deployerProvisionArgs`). `providersOf` maps each target frame id to the set of target frame ids
 * it uses (its consumer→provider connection edges, pre-filtered to the target set). Deterministic
 * tie-break: the PRIMARY (own) frame first, then ascending frame id. Connection cycles are legal
 * (see the initiative) — when no frame is fully unblocked the cycle is broken by emitting the same
 * deterministic pick, so ordering always makes progress.
 */
export function orderProvisionTargets(
  targets: ReadonlyArray<{ frameId: string; isPrimary: boolean }>,
  providersOf: ReadonlyMap<string, ReadonlySet<string>>,
): string[] {
  const meta = new Map(targets.map((t) => [t.frameId, t]))
  const remaining = new Set(targets.map((t) => t.frameId))
  const before = (a: string, b: string): number => {
    const pa = meta.get(a)?.isPrimary ? 0 : 1
    const pb = meta.get(b)?.isPrimary ? 0 : 1
    if (pa !== pb) return pa - pb
    return a < b ? -1 : a > b ? 1 : 0
  }
  const order: string[] = []
  while (remaining.size > 0) {
    let ready = [...remaining].filter((id) => {
      const providers = providersOf.get(id)
      return !providers || ![...providers].some((p) => remaining.has(p))
    })
    // A cycle among the remaining frames: none is fully unblocked. Break it deterministically.
    if (ready.length === 0) ready = [...remaining]
    ready.sort(before)
    const pick = ready[0]!
    order.push(pick)
    remaining.delete(pick)
  }
  return order
}

/**
 * The deploy step's eviction epoch: the total number of container-eviction re-dispatches so far
 * (genuine + transient infra churn). Drives {@link deployJobId} so each eviction recovery
 * dispatches a fresh job id, analogous to the agent path's `dispatchEpochFor`.
 */
export function deployEvictionEpoch(step: PipelineStep): number {
  return (step.evictionRecoveries ?? 0) + (step.transientEvictionRecoveries ?? 0)
}

// ---------------------------------------------------------------------------
// Run-start Deployer-config gate (pure half).
//
// When a pipeline INCLUDES an enabled `deployer` step, the environment it will stand up must be
// fully + correctly configured on BOTH sides of the "what/where ÷ how" split: the SERVICE owns
// the in-repo "what/where" (its declared provision type + manifest source / compose path /
// custom-manifest id), the WORKSPACE owns the "how" (an infra handler that resolves for the
// type + its credentials). A gap on either side means the deployer would fail mid-run (an async
// failed environment) or — for docker-compose with no handler — silently no-op, both of which
// this gate turns into an actionable up-front launch error. `ExecutionService` resolves the IO
// inputs (service config, handler resolution, an optional live connection probe) and translates
// the verdict into a `ConflictError` with a machine-readable reason the SPA deep-links off.
// ---------------------------------------------------------------------------

/**
 * Whether the ENABLED chain contains a `deployer` step. The Deployer-config gate fires only then:
 * a pipeline with no enabled deployer stands no environment up, so its provisioning config is
 * irrelevant. Mirrors the enabled-subset walk the other pipeline-shape checks use (`enabled?.[i]
 * !== false`), so a disabled deployer is correctly treated as absent.
 */
export function hasEnabledDeployerStep(
  agentKinds: readonly string[],
  enabled: readonly boolean[] | undefined,
): boolean {
  return agentKinds.some((kind, i) => enabled?.[i] !== false && kind === DEPLOYER_AGENT_KIND)
}

/**
 * The service-owned provisioning fields a Deployer REQUIRES to stand a `type` environment up (the
 * "what + where" the service must supply — the workspace handler owns the "how"). Returns the list
 * of MISSING field names; empty ⇒ the service config is complete for its type. `infraless` and an
 * undeclared type need nothing (the deployer stands nothing up), so they are always complete.
 *   - `kubernetes` → `manifestSource` (where the per-PR manifests live)
 *   - `docker-compose` → `composePath` OR a `recipe` that layers compose file(s)
 *   - `custom` → `manifestId` (the custom-manifest type matched to a remote-custom handler)
 */
export function deployerServiceConfigIssues(
  provisioning: ServiceProvisioning | undefined,
): string[] {
  switch (provisioning?.type) {
    case 'kubernetes':
      return provisioning.manifestSource ? [] : ['manifestSource']
    case 'docker-compose':
      return provisioning.composePath?.trim() ||
        (provisioning.recipe?.composeFiles?.length ?? 0) > 0
        ? []
        : ['composePath']
    case 'custom':
      return provisioning.manifestId ? [] : ['manifestId']
    default:
      return []
  }
}

export interface DeployerConfigInput {
  /** The service frame's declared provision type (undefined ⇒ none declared). */
  provisionType: ProvisionType | undefined
  /** Missing service-side provisioning fields for the type ([] ⇒ complete); see {@link deployerServiceConfigIssues}. */
  serviceIssues: readonly string[]
  /**
   * Whether a workspace handler resolves for the type (+ why not, when it doesn't) — the shape of
   * `EnvironmentProvisioningService.canProvision`. `ok: false` with no reason is treated as a
   * missing handler.
   */
  handlerResolution: { ok: boolean; reason?: 'no-handler' | 'type-mismatch' }
  /**
   * The resolved provider's connection-probe verdict, when one was run (the bonus TestConnection).
   * Absent ⇒ not probed (the provider has no `testConnection`, the probe faulted, or an earlier
   * structural check already failed so probing was skipped).
   */
  connectionTest?: { ok: boolean; message?: string }
}

export type DeployerConfigDecision =
  | { ok: true }
  | { ok: false; reason: 'service-config-incomplete'; missing: readonly string[] }
  | { ok: false; reason: 'workspace-unhandled'; handlerReason: 'no-handler' | 'type-mismatch' }
  | { ok: false; reason: 'connection-failed'; message?: string }

/**
 * Decide whether a Deployer-bearing pipeline may START, given the service's provisioning
 * completeness, whether a workspace handler resolves for its type, and (bonus) a live connection
 * probe. Ordered most-fundamental-first so the surfaced fix is the right one: an incomplete SERVICE
 * config is reported before the WORKSPACE handler (there's nothing to connect to a half-declared
 * service), and a failing connection only after both structural checks pass. `infraless`/undeclared
 * always pass — the deployer stands nothing up for them.
 */
export function decideDeployerConfig(input: DeployerConfigInput): DeployerConfigDecision {
  const { provisionType } = input
  if (!provisionType || provisionType === 'infraless') return { ok: true }
  if (input.serviceIssues.length > 0) {
    return { ok: false, reason: 'service-config-incomplete', missing: input.serviceIssues }
  }
  if (!input.handlerResolution.ok) {
    return {
      ok: false,
      reason: 'workspace-unhandled',
      handlerReason: input.handlerResolution.reason ?? 'no-handler',
    }
  }
  if (input.connectionTest && !input.connectionTest.ok) {
    return {
      ok: false,
      reason: 'connection-failed',
      ...(input.connectionTest.message ? { message: input.connectionTest.message } : {}),
    }
  }
  return { ok: true }
}
