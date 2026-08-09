// What the specs actually assert on.
//
// **The rule: assert on evidence the PLATFORM computed, never on prose an agent wrote.** An
// acceptance test that greps a coder's final reply for "fixed the off-by-one" is testing the
// model's turn of phrase; swap the model and it goes red having found nothing wrong. The
// verification report exists precisely because the platform derives its verdicts in code from
// captured facts (`CLAUDE.md` → "The model JUDGES; the platform COMPUTES"), so `reproduction.verdict`,
// `environments.proof` and `ci.verdict` are stable claims about what happened, and they are what
// this file reduces.
//
// Every reduction returns a `Check` rather than throwing, for one reason: a failing acceptance
// run should print EVERY unmet claim, not the first. A `pl_build` pass that both skipped its
// environment and failed CI is one story, and finding out about the second half on the next
// afternoon's re-run is how a long suite wastes a day per bug.

import type { PrVerificationReport } from '@cat-factory/sdk'

/** One claim about a run, and what the report actually said. */
export type Check = {
  claim: string
  ok: boolean
  /** What was observed, always populated: a passing check states its evidence too. */
  detail: string
}

export function check(claim: string, ok: boolean, detail: string): Check {
  return { claim, ok, detail }
}

/** Throw ONE error naming every unmet claim, or return quietly. */
export function assertChecks(context: string, checks: readonly Check[]): void {
  const failed = checks.filter((entry) => !entry.ok)
  if (failed.length === 0) return
  const lines = checks.map(
    (entry) => `  ${entry.ok ? 'ok  ' : 'FAIL'} ${entry.claim}: ${entry.detail}`,
  )
  throw new Error(
    `${context}: ${failed.length} of ${checks.length} claims failed.\n${lines.join('\n')}`,
  )
}

/**
 * The ephemeral environment stood up, was observed, and came back down.
 *
 * `proof` is the platform's own composed verdict over those three legs, and `gaps` names what is
 * missing when it is not `complete`, so this reduction reads BOTH rather than re-deriving the
 * judgement, which would let the suite disagree with the report it is quoting.
 *
 * `teardown` is checked separately because `complete` deliberately does NOT mean "nothing is
 * left standing": a deployer that declared the environment outlives the run is also complete.
 * For this suite it must not be, since the pipeline carries a `disposer` and a namespace left
 * behind on a developer's cluster is the mess that makes people stop running acceptance tests.
 */
export function checkEphemeralEnvironment(report: PrVerificationReport): Check[] {
  const { environments } = report
  const ready = environments.entries.filter((entry) => entry.status === 'ready')
  const failed = environments.entries.filter((entry) => entry.status === 'failed')
  return [
    check(
      'the deployer reported on an environment at all',
      environments.status === 'reported',
      `status=${environments.status}${environments.note ? ` (${environments.note})` : ''}`,
    ),
    check(
      'at least one environment came up',
      ready.length > 0,
      ready.length > 0
        ? `${ready.length} ready: ${ready.map((entry) => entry.url ?? entry.frameId).join(', ')}`
        : `none ready; ${failed.length} failed: ${failed.map((entry) => entry.error ?? entry.frameId).join('; ') || '(no entries)'}`,
    ),
    check(
      'the platform composed a complete environment proof',
      environments.proof === 'complete',
      `proof=${environments.proof}` +
        (environments.gaps.length ? `, gaps: ${environments.gaps.join('; ')}` : ''),
    ),
    check(
      'the disposer reclaimed the namespace and the reclaim was re-probed',
      environments.teardown === 'confirmed',
      `teardown=${environments.teardown}`,
    ),
  ]
}

/**
 * An environment URL from this report that is still worth putting in front of a person, or null.
 *
 * A `ready` entry is a fact about DEPLOY time, not about now, and a settled report is history: by
 * the time anything reads one, the run's `disposer` has been and gone. `teardown` is the platform's
 * own verdict on what is left standing, and only `retained` says the environment was DECLARED to
 * outlive its run. Everything else is either a confirmed reclaim or an unsettled one, and a URL
 * that may or may not answer is worse in a bug report than no URL at all: an investigator who gets
 * a connection refused concludes the reporter's environment is the fault and stops looking.
 *
 * This is the shape of the trap it exists to close. Spec 02 asserts `teardown === 'confirmed'` for
 * both feature runs, so every URL those reports hold is dead by construction, and reading one off
 * a `ready` entry sent spec 03's investigator to a host that answers nothing while the honest
 * "reproduce locally" fallback could never fire.
 */
export function retainedEnvironmentUrl(report: PrVerificationReport): string | null {
  if (report.environments.teardown !== 'retained') return null
  const ready = report.environments.entries.find((entry) => entry.status === 'ready' && entry.url)
  return ready?.url ?? null
}

/**
 * The bugfix run proved the defect: RED on the pre-fix tree, GREEN on the pushed tree.
 *
 * Only `reproduced` is proof. The other two verdicts are honest outcomes the platform is
 * designed to report rather than hide (`declared_infeasible` is an agent conceding structurally,
 * `inconclusive` a proof that could not be run symmetrically), and neither is what this suite
 * exists to demonstrate, so both fail the check WITH their stated reason attached rather than
 * being flattened into "no proof".
 */
export function checkReproductionProof(report: PrVerificationReport): Check[] {
  const { reproduction } = report
  const verdict = reproduction.verdict ?? null
  const why =
    reproduction.reason ??
    reproduction.note ??
    reproduction.observation ??
    '(the report gave no reason)'
  return [
    check(
      'the run produced a reproduction section',
      reproduction.status === 'reported',
      `status=${reproduction.status}, attempts=${reproduction.attempts}` +
        (reproduction.maxAttempts ? `/${reproduction.maxAttempts}` : ''),
    ),
    check(
      'the reproduction verdict is `reproduced`',
      verdict === 'reproduced',
      verdict === 'reproduced'
        ? `command: ${reproduction.command ?? '(none)'}`
        : `verdict=${verdict ?? 'null'}: ${why}`,
    ),
    check(
      'the pre-fix tree FAILED the reproduction (the defect was real)',
      reproduction.base?.passed === false,
      describePhase('base', reproduction.base),
    ),
    check(
      'the pushed tree PASSED the same command (the fix works)',
      reproduction.final?.passed === true,
      describePhase('final', reproduction.final),
    ),
    check(
      'no declared reproduction path was dropped before the proof ran',
      (reproduction.omittedTestPaths ?? 0) === 0,
      `testPaths=[${reproduction.testPaths.join(', ')}], omitted=${reproduction.omittedTestPaths ?? 0}`,
    ),
  ]
}

function describePhase(label: string, phase: PrVerificationReport['reproduction']['base']): string {
  if (!phase) return `${label}: absent`
  const setup = phase.setupFailed ? ', setup FAILED' : ''
  return `${label}: passed=${phase.passed}, exit=${phase.exitCode}${setup}`
}

/** Real CI went green on the pushed head. */
export function checkCi(report: PrVerificationReport): Check[] {
  const { ci } = report
  return [
    check(
      'the CI gate reported a verdict',
      ci.status === 'reported',
      `status=${ci.status}${ci.note ? ` (${ci.note})` : ''}`,
    ),
    check(
      'CI passed',
      ci.verdict === 'pass',
      `verdict=${ci.verdict ?? 'null'}, fixerAttempts=${ci.fixerAttempts}` +
        (ci.failingChecks.length
          ? `, failing: ${ci.failingChecks.map((entry) => entry.name).join(', ')}`
          : ''),
    ),
  ]
}

/**
 * The run reached a merge DECISION.
 *
 * Deliberately not "the pull request merged": whether it does is the workspace's merge-threshold
 * preset talking, and a deployment configured to hold everything for a person is correctly
 * configured, not broken. What this suite is entitled to assert is that the `merger` step ran and
 * the engine resolved its assessment into a recorded outcome: the difference between a pipeline
 * that completed and one that fell off the end.
 */
export function checkMergeDecision(report: PrVerificationReport): Check[] {
  const { merge } = report
  return [
    check(
      'the merger produced a scored assessment',
      merge.status === 'reported',
      `status=${merge.status}${merge.note ? ` (${merge.note})` : ''}`,
    ),
    check(
      'the engine resolved it into an outcome',
      Boolean(merge.outcome),
      `outcome=${merge.outcome ?? 'null'}, preset=${merge.presetName ?? 'null'}` +
        (merge.reason ? `, reason=${merge.reason}` : ''),
    ),
  ]
}

/**
 * Nothing in the report was silently clipped.
 *
 * Cheap, and it guards the assertions above rather than the run: `truncations` is how the report
 * states that a list it shows is not the whole list, and a check reading `failingChecks` off a
 * capped array would otherwise report a clean CI gate from a truncated tail.
 */
export function checkNotTruncated(report: PrVerificationReport): Check {
  return check(
    'the report is whole (nothing capped)',
    report.truncations.length === 0,
    report.truncations.join('; ') || 'no truncations',
  )
}
