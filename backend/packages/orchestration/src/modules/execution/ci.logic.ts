import type { CiCheck } from '@cat-factory/kernel'

/** The agent kind of the special CI-gate step (polls checks, loops the ci-fixer). */
export const CI_AGENT_KIND = 'ci'

/** The agent kind of the container agent that fixes failing CI on the PR branch. */
export const CI_FIXER_AGENT_KIND = 'ci-fixer'

/** The agent kind of the container agent that scores a PR for the merge decision. */
export const MERGER_AGENT_KIND = 'merger'

/**
 * The agent kind of the special pre-merge gate step: it checks whether the PR can
 * be merged and, on a conflict, loops the conflict-resolver — mirroring the CI gate.
 */
export const CONFLICTS_AGENT_KIND = 'conflicts'

/**
 * The agent kind of the container agent that resolves merge conflicts: it merges
 * the base into the PR branch, fixes the conflicts and pushes back onto the branch.
 */
export const CONFLICT_RESOLVER_AGENT_KIND = 'conflict-resolver'

/**
 * The aggregate CI verdict for a PR head commit, derived from its check runs:
 *  - `none`    — no checks reported (nothing to gate; treated as green).
 *  - `pending` — at least one check is still queued/in-progress and none failed.
 *  - `success` — every completed check succeeded (or was neutral/skipped) and none pending.
 *  - `failure` — at least one check concluded in a non-success terminal state.
 */
export type CiVerdict = 'none' | 'pending' | 'success' | 'failure'

/** Conclusions GitHub reports for a *completed* check that are NOT failures. */
const PASSING_CONCLUSIONS = new Set(['success', 'neutral', 'skipped'])

/**
 * Reduce a set of check runs to a single verdict. A failure dominates (one red
 * check fails the gate); otherwise a still-running check keeps it pending; with
 * everything completed-and-passing it is green; with no checks at all it is
 * `none` (the engine treats `none` as green so a repo with no CI configured isn't
 * blocked forever).
 */
export function aggregateCi(checks: CiCheck[]): CiVerdict {
  if (checks.length === 0) return 'none'
  let pending = false
  for (const check of checks) {
    if (check.status !== 'completed') {
      pending = true
      continue
    }
    const conclusion = check.conclusion ?? ''
    if (!PASSING_CONCLUSIONS.has(conclusion)) return 'failure'
  }
  return pending ? 'pending' : 'success'
}

/** Whether a verdict means the gate may advance (green or nothing to gate). */
export function isCiGreen(verdict: CiVerdict): boolean {
  return verdict === 'success' || verdict === 'none'
}

/** A short, human-readable summary of the failing checks, for the step output / notification. */
export function describeFailingChecks(checks: CiCheck[]): string {
  const failing = checks.filter(
    (c) => c.status === 'completed' && !PASSING_CONCLUSIONS.has(c.conclusion ?? ''),
  )
  if (failing.length === 0) return 'CI reported a failure.'
  const names = failing.map((c) => `${c.name} (${c.conclusion ?? 'failure'})`).join(', ')
  return `Failing checks: ${names}`
}
