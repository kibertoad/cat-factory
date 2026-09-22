import type { AgentJobHandle, RunnerImageVariant, RunnerJobRef } from '@cat-factory/kernel'
import type { AgentKindRegistry } from '@cat-factory/agents'

// How a container job is IDENTIFIED and ADDRESSED: the id the harness keys it by, the ref the
// transport routes it by, and the image variant that decides which container both mean.
//
// Extracted from `ContainerAgentExecutor` because the three answer one question ("which job, in
// which container") and the executor is at its size budget. They are pure functions of the run
// context or the job handle, which is what lets the dispatch site and the poll site derive the
// same answer with nothing carried between them: the poll runs in another process after a
// durable replay and rebuilds the handle from the persisted step alone.

// The per-dispatch job id itself lives in KERNEL (`stepJobId`), because the engine now mints the
// same string as a delegated step's correlation key and had to be able to commit it before any
// executor is called. Re-exported here so every existing importer keeps resolving it from the
// module that addresses container jobs.
export { stepJobId } from '@cat-factory/kernel'

/** The provider slug from a handle's `provider:model` string (fallback when the handle omits `provider`). */
export function providerOf(model: string | undefined): string {
  if (!model) return 'unknown'
  const colon = model.indexOf(':')
  return colon > 0 ? model.slice(0, colon) : model
}

/**
 * The executor image a kind's steps run on, as the kind DECLARED it on its registration
 * (`ui` selects the heavier Playwright + browser image; absent means the default one, so the
 * browser never bloats every other kind's cold start).
 *
 * Read at the dispatch site AND at the poll/stop site rather than persisted on the handle,
 * because a per-run container backend puts a differently-imaged step in its OWN container and
 * every later call has to address that one. Both sites already hold the agent kind, so the
 * variant is a pure function of state the step carries, and a handle minted before this existed
 * resolves to exactly what it ran on.
 */
export function imageVariantFor(
  agentKind: string | undefined,
  registry: AgentKindRegistry,
): RunnerImageVariant | undefined {
  return agentKind ? registry.agentStep(agentKind)?.image : undefined
}

/**
 * Every container a RUN holds, as image variants: `undefined` (the ordinary one, always — it is
 * where the run's default-image steps ran) plus one per NON-DEFAULT image any of the dispatched
 * kinds declared.
 *
 * This is what makes a run-level reclaim total. A per-run container backend hosts a whole run in
 * ONE container UNLESS a step declared a different image, and then there are two; addressing
 * only the ordinary one leaves a browser container running until its maximum lifetime elapses.
 * Deriving the set from the kinds the run DISPATCHED (rather than reclaiming every variant this
 * build knows) keeps the reclaim to containers that exist: `idFromName` answers a stub for a
 * container that never ran, so a blanket sweep would instantiate one per unused variant and
 * report the kill as a success.
 */
export function runImageVariants(
  agentKinds: readonly string[],
  registry: AgentKindRegistry,
): (RunnerImageVariant | undefined)[] {
  const variants = new Set<RunnerImageVariant | undefined>([undefined])
  for (const kind of agentKinds) {
    const image = imageVariantFor(kind, registry)
    if (image && image !== 'default') variants.add(image)
  }
  return [...variants]
}

/**
 * The {@link RunnerJobRef} a job handle addresses: the run (for the per-run container)
 * plus the per-step job id. Falls back to the job id as the run id for a handle minted
 * before run ids were carried (or a single-job flow where the two coincide).
 */
export function refForHandle(handle: AgentJobHandle, registry: AgentKindRegistry): RunnerJobRef {
  const image = imageVariantFor(handle.agentKind, registry)
  return {
    runId: handle.runId ?? handle.jobId,
    jobId: handle.jobId,
    ...(image ? { image } : {}),
  }
}
