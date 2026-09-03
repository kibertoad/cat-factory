import { repoPathSegments } from '~/utils/repoPath'

// The pure half of the bootstrap launch form's monorepo service-directory field. That field
// holds one string but carries two decisions: what the new directory is CALLED and WHERE in the
// repo it sits. Browsing the repo tree answers only the second, so it rewrites the parent and
// keeps the leaf, which means both halves have to be readable off the typed value on their own.
// Extracted for the reason every `*.logic.ts` here is: a decision worth a test should not need a
// mounted component to reach.

/**
 * What the new directory is called: the last segment of the typed path.
 *
 * Falls back to the service name, which is what the field's own seeding watcher would have put
 * there anyway, so opening the tree before typing a path still has a name to place. Empty only
 * when NEITHER is known, and that answer is load-bearing: with nothing to place, the tree can
 * decide nothing and says so rather than offering picks that compose a bare folder path.
 */
export function serviceDirectoryLeaf(directory: string, serviceName: string): string {
  return repoPathSegments(directory).at(-1) ?? serviceName.trim()
}

/**
 * The folder the typed path sits in, and so where the tree should OPEN: empty for a bare name,
 * because a name with no parent is a directory at the repo root.
 */
export function serviceDirectoryParent(directory: string): string {
  return repoPathSegments(directory).slice(0, -1).join('/')
}
