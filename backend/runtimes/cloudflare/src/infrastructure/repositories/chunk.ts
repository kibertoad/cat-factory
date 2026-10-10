/**
 * Cloudflare D1 rejects any prepared statement with more than 100 bound
 * parameters (`D1_ERROR: too many SQL variables`). Every dynamically-built
 * `IN (…)` list must therefore be chunked under that ceiling — with a little
 * headroom for the handful of other bound params a query carries alongside the
 * list (e.g. a leading `github_id = ?`).
 */
const D1_MAX_IN_PARAMS = 90

/**
 * Split `items` into consecutive chunks that stay under {@link D1_MAX_IN_PARAMS} bound
 * parameters.
 *
 * `paramsPerItem` is how many parameters ONE item contributes: 1 for a plain `id IN (…)` list,
 * 2 for a composite key matched as `(a = ? AND b = ?) OR …`. It is a divisor rather than a
 * caller-picked chunk size so the ceiling stays stated in the unit D1 actually enforces, and a
 * composite-key list cannot silently inherit a chunk size that was only safe for scalars.
 */
export function chunkForIn<T>(items: readonly T[], paramsPerItem = 1): T[][] {
  const perChunk = Math.max(1, Math.floor(D1_MAX_IN_PARAMS / Math.max(1, paramsPerItem)))
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += perChunk) {
    chunks.push(items.slice(i, i + perChunk))
  }
  return chunks
}
