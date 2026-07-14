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
