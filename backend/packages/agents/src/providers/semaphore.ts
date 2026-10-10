// A minimal async counting semaphore: bound how many async operations run at once.
// Hand-rolled because it is a genuinely different abstraction from a bounded `map` — a
// shared FIFO permit/mutex acquired at scattered call sites (with abort-aware queueing),
// not "run this list with a concurrency cap". Bounded-map fan-out uses `p-map` instead of
// re-rolling that (see `GitHubSyncService`, `readServiceSpec`); this stays in-tree only
// because `p-map` doesn't cover the shared-permit shape.
//
// Fairness is FIFO: waiters are released in the order they blocked, and a released permit
// is handed straight to the next waiter (never returned to the pool and re-raced), so a
// steady stream of arrivals can't starve an earlier waiter.
//
// A queued waiter can be cancelled with an `AbortSignal` — it leaves the queue and rejects
// without ever taking a permit, so an aborted caller (e.g. a cancelled run) never head-of-line
// blocks the others behind a slot it will not use.

/** Releases a held permit back to the semaphore. Idempotent — calling it twice is a no-op. */
export type PermitRelease = () => void

export class Semaphore {
  /** The total permit count the semaphore was built with (its max concurrency). */
  readonly permits: number
  private available: number
  private readonly waiters: Array<() => void> = []

  constructor(permits: number) {
    if (!Number.isInteger(permits) || permits < 1) {
      throw new Error(`Semaphore needs a positive integer permit count, got ${permits}`)
    }
    this.permits = permits
    this.available = permits
  }

  /**
   * Acquire a permit, resolving with the {@link PermitRelease} that returns it. If `signal` is
   * already aborted, or aborts while this call is still queued, the returned promise rejects with
   * the signal's reason and no permit is taken. Once a permit is granted the signal no longer
   * cancels it (the caller owns the permit and must `release()` it).
   */
  acquire(signal?: AbortSignal): Promise<PermitRelease> {
    if (signal?.aborted) return Promise.reject(abortReason(signal))
    if (this.available > 0) {
      this.available -= 1
      return Promise.resolve(this.makeRelease())
    }
    return new Promise<PermitRelease>((resolve, reject) => {
      const grant = () => {
        cleanup()
        resolve(this.makeRelease())
      }
      const onAbort = () => {
        const i = this.waiters.indexOf(grant)
        // Already granted (shifted out of the queue) — the permit is ours; let it stand.
        if (i < 0) return
        this.waiters.splice(i, 1)
        cleanup()
        reject(abortReason(signal!))
      }
      const cleanup = () => signal?.removeEventListener('abort', onAbort)
      this.waiters.push(grant)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  /** Build a single-use release for one granted permit. */
  private makeRelease(): PermitRelease {
    let released = false
    return () => {
      if (released) return
      released = true
      this.release()
    }
  }

  private release(): void {
    const next = this.waiters.shift()
    if (next) {
      // Transfer the permit directly to the waiter (available stays put).
      next()
    } else {
      this.available += 1
    }
  }

  /**
   * Acquire a permit, run `fn`, and release the permit even if `fn` throws. Pass `signal` to
   * cancel the wait while still queued (the acquire rejects and `fn` never runs).
   */
  async run<T>(fn: () => PromiseLike<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal)
    try {
      return await fn()
    } finally {
      release()
    }
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Aborted', 'AbortError')
}
