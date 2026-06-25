// Small, dependency-free URL helpers for matching a URL named in prose against the
// canonical `url` stored on an imported document/issue. Deliberately conservative:
// we only canonicalise differences that are semantically irrelevant (surrounding
// whitespace and a trailing slash) so a point lookup stays high-confidence.

/** Canonicalise a URL for equality: trim surrounding space and drop trailing slashes. */
export function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

/**
 * The two stored-`url` forms a reference can equal: the trailing-slash-stripped base
 * and that base with a single trailing slash. Lets a repository resolve a URL with a
 * `WHERE url IN (?, ?)` point lookup instead of scanning + normalising every row.
 */
export function urlMatchCandidates(url: string): [string, string] {
  const base = normalizeUrl(url)
  return [base, `${base}/`]
}
