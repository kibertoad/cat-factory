/**
 * Coalesce concurrent calls that ask for the SAME thing onto one request.
 *
 * Panel loads are the case this exists for: two openers routinely fire in the same tick (a window
 * and the shell it mounts in, a deep link plus the click that follows it, a tab restoring its own
 * state), and each fired its own fetch of the heaviest read on that surface. The second answer is
 * byte-for-byte the first, so the only thing the duplicate adds is load and a second chance to
 * land out of order.
 *
 * The in-flight entry is dropped when the promise SETTLES, so a later call re-fetches: this
 * coalesces concurrent work, it does not cache the answer. A rejection propagates to every joiner,
 * which is what makes joining equivalent to having asked.
 *
 * It does NOT replace a store's load-ordering ticket. Coalescing removes the duplicates a single
 * key can produce; a ticket settles which of two loads issued at different times may commit.
 */
export function useSingleFlight<K, T>() {
  const inFlight = new Map<K, Promise<T>>()

  /** Run `fn` for `key`, or join the call already running for it. */
  function run(key: K, fn: () => Promise<T>): Promise<T> {
    const pending = inFlight.get(key)
    if (pending) return pending
    const promise = fn().finally(() => {
      inFlight.delete(key)
    })
    inFlight.set(key, promise)
    return promise
  }

  /** Whether a call for `key` is currently running. */
  function isRunning(key: K): boolean {
    return inFlight.has(key)
  }

  return { run, isRunning }
}
