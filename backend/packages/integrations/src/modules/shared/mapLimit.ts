// A tiny in-tree bounded-concurrency map: run `fn` over `items` with at most `limit`
// promises in flight at once, preserving input order in the result. Hand-rolled on purpose
// — the repo prefers a small local limiter (see the server package's `readServiceSpec`
// mapLimit, the agents `Semaphore`) over pulling `p-limit`/`Bottleneck`, which would add a
// dependency behind the `minimumReleaseAge` install gate plus a `knip` ignore.
//
// Bounded (not a bare `Promise.all`) so a data-scaled fan-out — every repo a workspace
// links, every workspace an installation backs — can't fire an unbounded burst of
// concurrent GitHub reads and trip the provider's secondary (abuse) rate limits.

/** Map `items` through `fn` with at most `limit` in flight; results preserve input order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = Array.from<R>({ length: items.length })
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i]!, i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker))
  return results
}
