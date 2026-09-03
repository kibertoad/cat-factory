/**
 * Normalise a repo-root-relative path to its canonical, slash-trimmed form.
 *
 * GitHub returns tree entry paths with no surrounding slashes, but a stored service
 * `directory` may carry them, so both the monorepo directory picker and the tree
 * browser normalise before comparing a picked/added directory against a tree entry.
 */
export function normalizeRepoPath(p: string): string {
  return p.replace(/^\/+|\/+$/g, '')
}

/**
 * The meaningful segments of a hand-typed repo path: separators folded, blank and `.`
 * segments dropped, nothing else touched.
 *
 * Mirrors the reduction `normalizeServiceDirectory` performs server-side, so a field that
 * validates or splits a path here reaches the same reading the API will. `..` is DELIBERATELY
 * kept: it is what a caller checking for an escaping path has to see.
 */
export function repoPathSegments(p: string): string[] {
  return p
    .trim()
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s !== '' && s !== '.')
}

/**
 * Join a child name onto a repo-root-relative parent.
 *
 * An empty parent is the repo ROOT, where the child IS the whole path: a bare
 * `${parent}/${child}` emits a leading slash there, which is not the shape
 * `normalizeRepoPath` compares against and not what the API stores.
 */
export function joinRepoPath(parent: string, child: string): string {
  const base = normalizeRepoPath(parent.trim())
  return base ? `${base}/${child}` : child
}
