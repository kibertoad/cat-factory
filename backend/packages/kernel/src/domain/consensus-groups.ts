import type { ConsensusGating, ConsensusGroup, ConsensusStepConfig, TaskEstimate } from './types.js'

// ---------------------------------------------------------------------------
// TIERED consensus selection: which of a step's candidate model groups a task earns.
//
// A pipeline step names a SET of workspace consensus groups (`ConsensusStepConfig.groupIds`),
// each carrying its own estimate bar. This module answers "given this task's estimate, which
// one runs?" — the whole point of a group library, as opposed to one panel hard-wired onto the
// step: a light two-model review above 0.4 risk and the full five-model panel above 0.8 are
// then ONE step, not three conditional ones.
//
// Pure and dependency-free so both the engine's dispatch-time resolution and its unit tests
// run it without a repository. The engine materialises the winner onto the step's config; the
// consensus executor consumes that config exactly as it consumes an inline one.
// ---------------------------------------------------------------------------

/**
 * Whether an estimate clears a gating block's bar. The SAME rule the consensus executor's
 * `decideConsensusMode` applies (ANY supplied axis met or exceeded), stated once here because
 * the tier selection has to rank groups by it before any executor is involved.
 *
 *  - Gating absent / disabled ⇒ cleared unconditionally (the group is the floor).
 *  - Estimate absent ⇒ `onMissingEstimate` (default `consensus`, i.e. fail-safe to thoroughness:
 *    an un-estimated task has not been PROVEN low-stakes).
 *  - Otherwise cleared iff risk ≥ minRisk OR impact ≥ minImpact OR complexity ≥ minComplexity.
 *    A gating block that enables gating but supplies no threshold is never cleared on score —
 *    configuring a bar means naming one.
 */
export function clearsConsensusBar(
  gating: ConsensusGating | undefined,
  estimate: TaskEstimate | null | undefined,
): boolean {
  if (!gating || !gating.enabled) return true
  if (!estimate) return (gating.onMissingEstimate ?? 'consensus') === 'consensus'
  const axes: Array<[number | undefined, number]> = [
    [gating.minComplexity, estimate.complexity],
    [gating.minRisk, estimate.risk],
    [gating.minImpact, estimate.impact],
  ]
  return axes.some(([threshold, value]) => threshold !== undefined && value >= threshold)
}

/**
 * How demanding a group's bar is: the HIGHEST threshold it names across the three axes. An
 * ungated group scores -1 so it always sorts below every gated one — it is the floor by
 * construction, not by happening to name a low number.
 */
export function consensusGroupBar(group: ConsensusGroup): number {
  const g = group.gating
  if (!g.enabled) return -1
  const thresholds = [g.minComplexity, g.minRisk, g.minImpact].filter(
    (t): t is number => t !== undefined,
  )
  return thresholds.length ? Math.max(...thresholds) : -1
}

/**
 * Pick the group a task has earned: among the candidates whose bar the estimate clears, the
 * one that set the HIGHEST bar. A task that clears 0.8 has also cleared 0.4, and the more
 * demanding panel is the one the operator meant it to get.
 *
 * Ties break on panel size (more participants first) and then on id, so the choice is
 * deterministic across a replayed durable run — two groups with the same bar must not resolve
 * differently on a re-drive, or a step's transcript would disagree with itself.
 *
 * Returns null when no candidate clears, which the caller reads as "run the standard
 * single-actor agent" — the same disposition an ungated, un-cleared inline config gets.
 */
export function selectConsensusGroup(
  groups: readonly ConsensusGroup[],
  estimate: TaskEstimate | null | undefined,
): ConsensusGroup | null {
  const eligible = groups.filter((g) => clearsConsensusBar(g.gating, estimate))
  if (!eligible.length) return null
  return eligible.reduce((best, candidate) => (outranks(candidate, best) ? candidate : best))
}

function outranks(candidate: ConsensusGroup, best: ConsensusGroup): boolean {
  const byBar = consensusGroupBar(candidate) - consensusGroupBar(best)
  if (byBar !== 0) return byBar > 0
  const bySize = candidate.participants.length - best.participants.length
  if (bySize !== 0) return bySize > 0
  return candidate.id < best.id
}

/**
 * Materialise a selected group onto a step's consensus config: the group supplies the panel
 * (strategy, participants, synthesizer, rounds) and STAMPS its identity via `selectedGroup`,
 * so the session transcript can name the tier that fired even after the library row is edited
 * or deleted.
 *
 * The group's own `gating` is deliberately NOT copied onto the result. The bar has already
 * been evaluated here — carrying it forward would have the executor re-decide the same
 * question against the same estimate, and any future divergence between the two evaluations
 * would silently turn a selected tier into a skipped step. The materialised config is
 * ungated: selection IS the gate.
 */
export function applyConsensusGroup(
  config: ConsensusStepConfig,
  group: ConsensusGroup,
): ConsensusStepConfig {
  const { gating: _dropped, ...rest } = config
  return {
    ...rest,
    strategy: group.strategy,
    participants: group.participants,
    ...(group.synthesizerModelId ? { synthesizerModelId: group.synthesizerModelId } : {}),
    ...(group.rounds !== undefined ? { rounds: group.rounds } : {}),
    selectedGroup: { id: group.id, name: group.name },
  }
}
