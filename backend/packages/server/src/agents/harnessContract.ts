import {
  CONTEXT_DIR,
  EFFORT_REPORT_FILE,
  FOLLOW_UPS_FILE,
  PR_DESCRIPTION_FILE,
  DESIGN_RENDER_DIR,
  GENERATED_BINARY_DIR,
  REFERENCE_SCREENSHOT_DIR,
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
 * A short deterministic digest of the EXACT `owner` / `name` pair, before sanitisation.
 *
 * FNV-1a over `owner\0name`. The NUL separator is what makes it a digest of the PAIR rather than
 * of a concatenation: without it `('a', 'bc')` and `('ab', 'c')` digest alike, which is the very
 * ambiguity it is here to remove. Hand-rolled rather than taken from `node:crypto` because this
 * function has to exist twice: once here (running on Node AND in workerd) and once in the harness
 * image, which builds from its own `src/` plus typescript and may depend on nothing else.
 *
 * MUST stay byte-identical to the harness's copy; see {@link siblingCheckoutDir}.
 */
export function checkoutDirDigest(owner: string, name: string): string {
  const input = `${owner}\u0000${name}`
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    // The FNV prime (16777619) as shifts, with `>>> 0` folding the result back to uint32 every
    // step so the arithmetic never drifts into float range and diverges between engines.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0
  }
  return hash.toString(36).padStart(7, '0')
}

/**
 * The sibling checkout directory the harness creates for a repo under the multi-repo workspace
 * root. MUST stay byte-identical to the harness's `makeDirClaimer` join (computed in
 * executor-harness `coding-agent.ts`): the two are independent, so a divergent rule would name a
 * directory in the agent's prompt that does not exist on disk.
 *
 * The readable `owner__name` prefix does NOT identify a repo on its own, which is why the digest
 * is appended. Two distinct repos collapse onto one prefix in both directions:
 *
 *  - {@link safeDirSegment} maps a whole class of characters onto `-`, so the GitLab namespace
 *    path `grp/sub` and a top-level group literally named `grp-sub` sanitise to the same segment.
 *  - The `__` join is ambiguous once a segment may contain `_`. GitHub owners cannot, which is
 *    where the old "collision-free by construction" claim came from, but a GitLab `owner` is a
 *    NAMESPACE PATH and GitLab paths allow `_`, so `('a__b', 'c')` and `('a', 'b__c')` both read
 *    as `a__b__c`.
 *
 * A collision is not silent, but it is not survivable either: the second leg's `git clone` lands
 * on a directory the first leg already filled and the run dies in the clone phase naming neither
 * repo. Appending a digest of the unsanitised pair keeps the name a PURE function of that pair,
 * which is what lets the harness, this module and the merger prompt each compute it independently
 * with no shared ordering or state, and makes the full name collide only if the prefix AND the
 * digest do.
 */
export function siblingCheckoutDir(owner: string, name: string): string {
  return `${safeDirSegment(owner)}__${safeDirSegment(name)}__${checkoutDirDigest(owner, name)}`
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
  /** Where a capturing run's reference design images are downloaded to, and read from. */
  referenceScreenshots: REFERENCE_SCREENSHOT_DIR,
  /** Where a building run's design pictures are downloaded to, and read from. */
  designRenders: DESIGN_RENDER_DIR,
  /** Where a harness-served generator's output is staged for the agent to store. */
  generatedBinaries: GENERATED_BINARY_DIR,
} as const
