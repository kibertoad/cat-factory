/**
 * Cloudflare D1 rejects any prepared statement with more than 100 bound
 * parameters (`D1_ERROR: too many SQL variables`). Every dynamically-built
 * `IN (…)` list must therefore be chunked under that ceiling — with a little
 * headroom for the handful of other bound params a query carries alongside the
 * list (e.g. a leading `github_id = ?`).
 */
export const D1_MAX_IN_PARAMS = 90

/** Split `items` into consecutive chunks no larger than {@link D1_MAX_IN_PARAMS}. */
export function chunkForIn<T>(items: readonly T[]): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += D1_MAX_IN_PARAMS) {
    chunks.push(items.slice(i, i + D1_MAX_IN_PARAMS))
  }
  return chunks
}
