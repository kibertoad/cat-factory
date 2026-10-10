// Load scoping for ISOLATE runtimes, where a promise may not outlive the invocation that
// created it.
//
// On Cloudflare Workers every invocation gets its own I/O context, and a promise created while
// serving one may never be awaited by another: workerd destroys the joining invocation with
// "Cannot perform I/O on behalf of a different request". That fault is raised at the RUNTIME
// level, so the joining code cannot catch it: its work simply disappears, which is why this
// cannot be handled where it surfaces and has to be made impossible instead.
//
// The app cache bag is one per ISOLATE (that is what makes the entries caches rather than
// per-invocation memos), so layered-loader's in-flight load coalescing (`runningLoads`) would
// hand exactly such a promise to a second concurrent invocation on every same-key MISS. This
// guard keeps the coalescing where it is safe (within ONE invocation, which is the common case
// it exists for: a batch read issuing the same key twice) and removes it where it is not.
//
// Nothing here is needed on Node, where one process serves every request out of one I/O
// context; a facade that supplies no `currentInvocation` keeps layered-loader's own load path
// unchanged.

/** The outcome of one guarded read, so the caller keeps owning its hit/miss accounting. */
export interface InvocationScopedLoadResult<T> {
  value: T
  /** Whether THIS caller ran the load, as opposed to joining one already in flight. */
  loaded: boolean
}

/**
 * Per-invocation coalescing of cache-miss loads, plus the local fence their publish needs.
 *
 * One instance per cache handle. `currentInvocation` returns an object identifying the
 * invocation being served, or `undefined` outside any bracketed entry point (a Workflows step,
 * which has no ExecutionContext). An absent invocation coalesces with NOTHING, because
 * two loads that cannot be told apart must be assumed to belong to different contexts.
 */
export class InvocationScopedLoads<T> {
  /**
   * In-flight loads, partitioned by invocation so a lookup can never return another
   * invocation's promise. Weak, so an invocation's partition is collected with it: an entry
   * point that ends mid-load leaks neither the map nor the promise.
   */
  private readonly inFlight = new WeakMap<object, Map<string, Promise<T>>>()
  /** Monotonic; every invalidation of this cache bumps it. See {@link loadAndPublish}. */
  private invalidations = 0

  constructor(private readonly currentInvocation: () => object | undefined) {}

  /**
   * Record that this cache was invalidated, from any source: its own write path, or a
   * coherency probe applying a peer's. Breaks the fence for every load currently in flight.
   */
  noteInvalidation(): void {
    this.invalidations += 1
  }

  /**
   * Run (or join, within this same invocation only) the load for one cache key, publishing the
   * result through `publish` when the fence holds.
   */
  async run(
    cacheKey: string,
    load: () => Promise<T>,
    publish: (value: T) => Promise<void>,
  ): Promise<InvocationScopedLoadResult<T>> {
    const invocation = this.currentInvocation()
    if (!invocation) {
      return { value: await this.loadAndPublish(load, publish), loaded: true }
    }
    let partition = this.inFlight.get(invocation)
    if (!partition) {
      partition = new Map()
      this.inFlight.set(invocation, partition)
    }
    const joined = partition.get(cacheKey)
    // Safe to await: this promise was created while serving THIS invocation.
    if (joined) return { value: await joined, loaded: false }

    const loading = this.loadAndPublish(load, publish)
    partition.set(cacheKey, loading)
    try {
      return { value: await loading, loaded: true }
    } finally {
      partition.delete(cacheKey)
    }
  }

  private async loadAndPublish(
    load: () => Promise<T>,
    publish: (value: T) => Promise<void>,
  ): Promise<T> {
    const fence = this.invalidations
    const value = await load()
    // Publish only when no invalidation landed while the load was running, or a late write
    // would resurrect the entry that invalidation dropped. layered-loader fences its own load
    // path this way (`backgroundWriteFences`); this path is ours, so the fence is ours too.
    // The counter is cache-WIDE rather than per key, so an unrelated invalidation costs one
    // skipped cache write: over-invalidation, never a stale serve.
    if (this.invalidations === fence) await publish(value)
    return value
  }
}
