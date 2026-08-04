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
 *
 * NULL for a needle that normalises to nothing, and a caller must answer "no match" rather than
 * querying: an empty needle is not a URL, and a stored `url` is legitimately EMPTY for a document
 * with no origin page (an `upload`). Returning the pair anyway makes `IN ('', '/')` match every
 * such row, so a lookup for nothing resolves to an arbitrary uploaded document, which the caller
 * then hands an agent as the page a description pointed at. The `| null` is what forces each
 * repository to say so rather than remember to.
 */
export function urlMatchCandidates(url: string): readonly [string, string] | null {
  const base = normalizeUrl(url)
  if (!base) return null
  return [base, `${base}/`]
}
