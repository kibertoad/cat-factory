// A minimal async counting semaphore: bound how many async operations run at once.
// Hand-rolled on purpose — the repo prefers a tiny in-tree limiter (the GitHub-read
// `mapLimit`, the `withDirLock` mutex) over pulling `p-limit`/`Bottleneck`, which would
// add a dependency behind the `minimumReleaseAge` install gate plus a `knip` ignore.
//
// Fairness is FIFO: waiters are released in the order they blocked, and a released permit
// is handed straight to the next waiter (never returned to the pool and re-raced), so a
// steady stream of arrivals can't starve an earlier waiter.

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

  private async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available -= 1
      return
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve))
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

  /** Acquire a permit, run `fn`, and release the permit even if `fn` throws. */
  async run<T>(fn: () => PromiseLike<T>): Promise<T> {
    await this.acquire()
    try {
      return await fn()
    } finally {
      this.release()
    }
  }
}
