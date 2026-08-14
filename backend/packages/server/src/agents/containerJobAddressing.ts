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

/**
 * The harness job id for one dispatch: the run (execution) id, the agent kind, and — past the
 * first job of that kind in the run — the `dispatchEpoch`. A run executes a sequence of steps that
 * all share the one per-run container, so each job needs an id that is UNIQUE WITHIN THE RUN: the
 * harness keys its per-kind job registries by it, and two jobs sharing an id alias there (the bug
 * where an `architect` /explore poll read back the `spec-writer`'s /spec result). The run itself is
 * addressed separately by the execution id (the {@link RunnerJobRef.runId}).
 *
 * The epoch is what makes that uniqueness total, because the engine dispatches one kind more than
 * once per run in two ways: a step RE-dispatched (a Tester re-test after a fixer round, a gate's
 * helper retry, a companion's rework round, an eviction recovery) and the same helper kind
 * escalated off DIFFERENT steps (`fixer` serves four gates). The harness re-attaches to an EXISTING
 * job id rather than re-running (replay idempotency), and a container-reusing transport — a warm
 * local pool, a self-hosted runner pool — keeps that registry alive across rounds, since reclaiming
 * a pooled member does NOT destroy it. So a reused id replays a completed job: the Tester that
 * appeared to "pass regardless" and never re-tested, an eviction recovery landing back on the job
 * whose runner just died. `dispatchEpochFor` counts the run's prior dispatches of the kind, so the
 * id names the n-th job of that kind and the run's first keeps the unsuffixed shape.
 */
export function stepJobId(executionId: string, agentKind: string, dispatchEpoch = 0): string {
  const base = `${executionId}-${agentKind}`
  return dispatchEpoch > 0 ? `${base}-${dispatchEpoch}` : base
}

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
