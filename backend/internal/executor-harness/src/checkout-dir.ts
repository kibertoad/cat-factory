import type { RepoSpec } from './job.js'

// ---------------------------------------------------------------------------
// The HARNESS half of the sibling-checkout-directory contract.
//
// The harness CREATES these directories; `@cat-factory/server`'s `agents/harnessContract.ts`
// NAMES them in the agent's prompt. The image builds from this `src/` plus typescript and may
// depend on no workspace package, so the two halves are computed INDEPENDENTLY and pinned against
// each other by `test/harness-contract.conformity.test.ts`. Extracted out of `coding-agent.ts` so
// the pairing sits in one small module per side rather than buried in the agent runner: the whole
// point of the pairing is that a reader can see both halves at once.
// ---------------------------------------------------------------------------

/** Sanitise an owner/name into a safe single path segment for a sibling checkout directory. */
export function safeDirSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '-') || '_'
}

/**
 * A short deterministic digest of the EXACT `owner` / `name` pair, before sanitisation. FNV-1a
 * over `owner\0name`; the NUL separator makes it a digest of the PAIR rather than of a
 * concatenation, so `('a', 'bc')` and `('ab', 'c')` cannot share one. Hand-rolled rather than
 * taken from `node:crypto` because the backend needs the identical function and runs it in
 * workerd as well as on Node.
 *
 * MUST stay byte-identical to the backend's `checkoutDirDigest`
 * (`@cat-factory/server`, `agents/harnessContract.ts`); see {@link makeDirClaimer}.
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
 * A sibling-directory allocator for a multi-repo run: returns the checkout directory name for a
 * repo under the workspace root. A pure function of the pair (`owner__name__digest`), which is
 * what lets this and the backend compute it independently with no shared ordering or state. Kept
 * as a factory so the coding + read-only explore fan-outs share ONE scheme, and it MUST stay
 * byte-identical to the backend's `siblingCheckoutDir` / `renderMultiRepoWorkspaceSection` in
 * `@cat-factory/server`, which names this exact directory in the agent's prompt: the two are
 * computed independently, so a divergent rule would point the agent at a directory that does not
 * exist.
 *
 * The readable `owner__name` prefix does not identify a repo on its own, which is why the digest
 * is there. {@link safeDirSegment} folds a whole class of characters onto `-`, so a GitLab
 * namespace path `grp/sub` and a group literally named `grp-sub` sanitise alike; and the `__`
 * join is ambiguous once a segment may contain `_`, which GitHub owners cannot but GitLab
 * namespace paths can, so `('a__b', 'c')` and `('a', 'b__c')` both read as `a__b__c`. Either
 * collision puts two legs on one directory, and the second one's clone then fails against a
 * directory the first already filled, killing the run in the clone phase naming neither repo.
 */
export function makeDirClaimer(): (repo: Pick<RepoSpec, 'name' | 'owner'>) => string {
  return (repo) =>
    `${safeDirSegment(repo.owner)}__${safeDirSegment(repo.name)}__${checkoutDirDigest(repo.owner, repo.name)}`
}
