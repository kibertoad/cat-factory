import {
  CONTEXT_DIR,
  EFFORT_REPORT_FILE,
  FOLLOW_UPS_FILE,
  PR_DESCRIPTION_FILE,
} from '@cat-factory/agents'

// ---------------------------------------------------------------------------
// The BACKEND half of the filesystem contract with the executor harness.
//
// The harness image builds from its own `src/` plus typescript alone, so it can depend on no
// workspace package: every path both sides must agree about is computed INDEPENDENTLY on each
// side. This module is the one place the backend half is named, so the pairing is a single
// import for the harness's conformity suite rather than a set of literals scattered across
// prompt text and body builders.
//
// The two halves are pinned byte-for-byte by
// `backend/internal/executor-harness/test/harness-contract.conformity.test.ts`. A drift here is
// silent in a way a type cannot catch: the harness creates a directory or writes a sentinel file
// under one name while the agent's prompt names another, so the agent reads nothing, writes
// where nobody looks, or edits the wrong repository.
// ---------------------------------------------------------------------------

/**
 * Sanitise an owner/name segment for a sibling checkout directory. MUST match the harness's
 * `safeDirSegment` (executor-harness `coding-agent.ts`); see {@link siblingCheckoutDir}.
 */
export function safeDirSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '-') || '_'
}

/**
 * The sibling checkout directory the harness creates for a repo under the multi-repo workspace
 * root. MUST stay byte-identical to the harness's `makeDirClaimer` join (`owner__name`, computed
 * in executor-harness `coding-agent.ts`): the two are independent, so a divergent rule would name
 * a directory in the agent's prompt that does not exist on disk (the agent would edit the wrong
 * repo). GitHub owners contain no `_`, so `owner__name` is collision-free across the deduped set.
 */
export function siblingCheckoutDir(owner: string, name: string): string {
  return `${safeDirSegment(owner)}__${safeDirSegment(name)}`
}

/**
 * The sentinel paths the prompt text names and the harness materialises, reads or removes. Each
 * exists once here and once in the harness; the conformity suite asserts the pairs are equal.
 */
export const HARNESS_SENTINEL_PATHS = {
  /** The agent's effort self-assessment, read + removed by the harness after the run. */
  effortReport: EFFORT_REPORT_FILE,
  /** The reviewer briefing a PR-opening agent writes, lifted onto `openPullRequest`. */
  prDescription: PR_DESCRIPTION_FILE,
  /** The injected-context directory the engine materialises into the checkout. */
  contextDir: CONTEXT_DIR,
  /** The follow-up companion's append-only side channel, tailed live by the harness. */
  followUps: FOLLOW_UPS_FILE,
} as const
