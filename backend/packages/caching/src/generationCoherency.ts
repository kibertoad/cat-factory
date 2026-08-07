import type { Logger, OperationalMetrics } from '@cat-factory/kernel'
import { describeError, noopOperationalMetrics } from '@cat-factory/kernel'

// Pull-based cross-instance coherency for the app caches, built for runtimes where push is
// structurally unavailable (a Cloudflare Worker isolate can hold no subscription between
// requests, so a notification pair cannot reach it). The model is the generation-counter
// scheme layered-loader's own edge-runtime guidance describes: a shared strongly-consistent
// directory holds one monotonic counter per (cache, group); a write bumps the counter right
// after its local invalidation; a read probes the directory at most once per short window and,
// on a moved counter, applies layered-loader 16.1's `applyRemoteInvalidation*` primitives:
// synchronous, purely local, fence-carrying, and non-publishing, so an in-flight load cannot
// resurrect the invalidated entry and nothing echoes back onto a bus.
//
// Cross-isolate staleness is bounded by the probe window (plus one probe's latency), instead
// of being indefinite (a bare TTL) or zero-at-the-cost-of-every-read (pass-through).

/**
 * One shared, cross-instance generation directory. The contract every implementation must
 * honour: counters are MONOTONIC per (cache, group) and a group's counters are readable in
 * ONE round trip: the batched read is what lets every coherent cache share a single probe
 * per group per window. On the Worker this is a Durable Object namespace sharded by group;
 * tests inject an in-memory fake.
 */
export interface CacheGenerationStore {
  /**
   * Every cache's generation counter for one group. A cache absent from the result has
   * generation 0 (never bumped).
   */
  getGenerations(group: string): Promise<Record<string, number>>
  /** Increment one cache's counter for a group; resolves to the NEW generation. */
  bump(cacheName: string, group: string): Promise<number>
}

/**
 * The reserved group that carries cache-WIDE invalidation (`invalidateAll`) as an epoch
 * counter, so the store interface stays two methods. It is probed beside the real group on
 * its own timestamp, and a moved epoch maps to a full local clear.
 */
export const CACHE_EPOCH_GROUP = '*'

/** What one coherent cache hands the tracker: its identity, cadence, and the 16.1 primitives. */
export interface CoherentCacheRegistration {
  cacheName: string
  /** Probe cadence; a group snapshot older than this re-reads the directory before serving. */
  windowMsecs: number
  /**
   * Whether this cache ever invalidates CACHE-WIDE, and so needs the reserved epoch group
   * probed beside its own.
   *
   * Declared per cache because the epoch shard is ONE globally-placed Durable Object: probing
   * it is a cross-colo round trip awaited on the read path of every isolate, and a cache with
   * no `invalidateAll` call site can never move that counter, so it would be a round trip that
   * structurally cannot return news. Declared rather than inferred from call sites, and the
   * handle REFUSES an undeclared `invalidateAll` rather than dropping entries locally while
   * peers keep serving them.
   */
  probesEpoch: boolean
  /** layered-loader's local, fencing, non-publishing group invalidation. */
  applyRemoteInvalidationForGroup(group: string): void
  /** Its cache-wide form, for a moved epoch. */
  applyRemoteInvalidation(): void
}

interface GroupState {
  /** Set only by a successful FULL probe; a bump alone never refreshes the window. */
  lastProbeAt: number | undefined
  /** Last generation this instance has seen or produced, per cache. */
  generations: Map<string, number>
  /**
   * Concurrent reads coalesce onto one in-flight probe per group, but ONLY within the
   * invocation that started it: the probe is a Durable Object round trip, so on an isolate
   * runtime its promise is exactly the kind another invocation may not await (see
   * `invocationScopedLoads.ts` for the full reasoning and the failure mode).
   */
  inflight: { invocation: object | undefined; promise: Promise<void> } | undefined
}

/**
 * The stand-in invocation for a runtime that has no such concept: one process serving every
 * request out of one I/O context, so every probe belongs to the same "invocation" and
 * coalescing behaves exactly as it did before the distinction existed.
 */
const SINGLE_INVOCATION: object = { runtime: 'single-context' }

export interface GroupGenerationTrackerOptions {
  logger?: Logger
  metrics?: OperationalMetrics
  now?: () => number
  /**
   * Supplied ONLY by an isolate runtime; see `CreateAppCachesOptions.currentInvocation`. It
   * decides which in-flight probes may be joined. Absent ⇒ every probe coalesces, which is
   * correct wherever one I/O context serves everything.
   */
  currentInvocation?: () => object | undefined
  /**
   * LRU bound on per-group bookkeeping. Evicting a group loses its baselines, which the next
   * probe treats as "possibly missed a bump" and re-invalidates (an over-invalidation, never
   * a stale serve), so the bound trades a little re-loading for bounded memory.
   */
  maxTrackedGroups?: number
}

/**
 * The per-instance bookkeeping half of the scheme: which generation each (cache, group) was
 * last seen at, when each group was last probed, and the application of a moved counter onto
 * the registered caches. One tracker serves the whole cache bag, so all coherent caches share
 * each group's probe.
 *
 * Error posture, deliberately asymmetric:
 * - a PROBE failure fails CLOSED: the affected caches are locally invalidated and the read
 *   loads fresh, so a directory outage degrades to pass-through performance, never to serving
 *   stale (`container.ts`'s "a stale-serving cache would be a correctness bug" stance);
 * - a BUMP failure fails OPEN: the write and its local invalidation already happened, peers
 *   heal at the cache TTL, and the counter + warn line are the visible trace.
 */
export class GroupGenerationTracker {
  private readonly registrations = new Map<string, CoherentCacheRegistration>()
  private readonly groups = new Map<string, GroupState>()
  /** Held outside the LRU map: the epoch baseline must never be evicted. */
  private readonly epoch: GroupState = {
    lastProbeAt: undefined,
    generations: new Map(),
    inflight: undefined,
  }
  private readonly log: Logger | undefined
  private readonly metrics: OperationalMetrics
  private readonly now: () => number
  private readonly maxTrackedGroups: number
  private readonly currentInvocation: () => object | undefined

  constructor(
    private readonly store: CacheGenerationStore,
    options: GroupGenerationTrackerOptions = {},
  ) {
    this.log = options.logger
    this.metrics = options.metrics ?? noopOperationalMetrics
    this.now = options.now ?? Date.now
    this.maxTrackedGroups = options.maxTrackedGroups ?? 2000
    this.currentInvocation = options.currentInvocation ?? (() => SINGLE_INVOCATION)
  }

  register(registration: CoherentCacheRegistration): void {
    this.registrations.set(registration.cacheName, registration)
  }

  /**
   * Called by a coherent handle before its read. Resolves without I/O while the group's (and
   * the epoch's) snapshot is inside the calling cache's window; otherwise one coalesced store
   * round trip refreshes every registered cache's view of the group. Never rejects.
   */
  async ensureFresh(cacheName: string, group: string): Promise<void> {
    const registration = this.registrations.get(cacheName)
    if (!registration) return
    const probes: Promise<void>[] = []
    const groupState = this.touchGroup(group)
    if (this.isStale(groupState, registration.windowMsecs)) {
      probes.push(this.probe(groupState, group))
    }
    if (registration.probesEpoch && this.isStale(this.epoch, registration.windowMsecs)) {
      probes.push(this.probe(this.epoch, CACHE_EPOCH_GROUP))
    }
    if (probes.length > 0) await Promise.all(probes)
  }

  /**
   * Called by a coherent handle AFTER its local invalidation, awaited by the write path so
   * "invalidate right after the write commits" spans the directory too. The returned
   * generation is max-merged into the baseline, so the writing instance's next probe does not
   * read its own bump as a peer's change and re-invalidate what it just reloaded.
   */
  async noteLocalInvalidation(cacheName: string, group: string): Promise<void> {
    try {
      const generation = await this.store.bump(cacheName, group)
      const state = group === CACHE_EPOCH_GROUP ? this.epoch : this.touchGroup(group)
      mergeGeneration(state, cacheName, generation)
    } catch (error) {
      this.metrics.increment('cache.coherency_bump_failure', { cache: cacheName })
      this.log?.warn('cache coherency bump failed; peers heal at the cache TTL', {
        cache: cacheName,
        group,
        ...describeError(error),
      })
    }
  }

  private isStale(state: GroupState, windowMsecs: number): boolean {
    return state.lastProbeAt === undefined || this.now() - state.lastProbeAt >= windowMsecs
  }

  /** LRU-touch the group's state, evicting the oldest when over the bound. */
  private touchGroup(group: string): GroupState {
    let state = this.groups.get(group)
    if (state) {
      this.groups.delete(group)
    } else {
      state = { lastProbeAt: undefined, generations: new Map(), inflight: undefined }
    }
    this.groups.set(group, state)
    if (this.groups.size > this.maxTrackedGroups) {
      const oldest = this.groups.keys().next().value
      if (oldest !== undefined) this.groups.delete(oldest)
    }
    return state
  }

  private probe(state: GroupState, group: string): Promise<void> {
    const invocation = this.currentInvocation()
    const inflight = state.inflight
    // `undefined` never matches, not even itself: an invocation the runtime cannot name is one
    // this probe cannot prove it shares an I/O context with, and joining wrongly is fatal where
    // starting a second probe merely costs a round trip.
    if (inflight && invocation !== undefined && inflight.invocation === invocation) {
      return inflight.promise
    }
    const promise = this.runProbe(state, group).finally(() => {
      if (state.inflight?.promise === promise) state.inflight = undefined
    })
    state.inflight = { invocation, promise }
    return promise
  }

  private async runProbe(state: GroupState, group: string): Promise<void> {
    const scope = group === CACHE_EPOCH_GROUP ? 'epoch' : 'group'
    try {
      const fetched = await this.store.getGenerations(group)
      this.metrics.increment('cache.coherency_probe', { scope })
      for (const registration of this.affectedBy(scope)) {
        const generation = fetched[registration.cacheName] ?? 0
        // Counters are monotonic, so only a HIGHER generation is a peer's change: a lower one
        // can only be a store read racing this instance's own concurrent bump. An evicted or
        // never-seen baseline reads as 0, so any bump that ever happened re-invalidates,
        // over-invalidation, never a stale serve.
        const changed = generation > (state.generations.get(registration.cacheName) ?? 0)
        if (changed) {
          this.applyInvalidation(registration, scope, group)
          this.metrics.increment('cache.coherency_invalidation', {
            cache: registration.cacheName,
          })
        }
        mergeGeneration(state, registration.cacheName, generation)
      }
      state.lastProbeAt = this.now()
    } catch (error) {
      // Fail CLOSED: invalidate locally and leave the window stale, so reads load fresh (and
      // re-probe) until the directory answers again: pass-through performance, zero staleness.
      this.metrics.increment('cache.coherency_probe_failure', { scope })
      for (const registration of this.affectedBy(scope)) {
        this.applyInvalidation(registration, scope, group)
      }
      this.log?.warn('cache coherency probe failed; affected reads load fresh', {
        scope,
        group,
        ...describeError(error),
      })
    }
  }

  /**
   * The caches one probe speaks for. A GROUP probe speaks for every registered cache (they
   * share the group's shard, which is what makes the batched read worth doing); an EPOCH probe
   * speaks only for those that declared a cache-wide invalidation path, so a cache that opted
   * out is neither invalidated by it nor has its baseline moved by it.
   */
  private affectedBy(scope: 'group' | 'epoch'): CoherentCacheRegistration[] {
    const all = [...this.registrations.values()]
    return scope === 'epoch' ? all.filter((registration) => registration.probesEpoch) : all
  }

  private applyInvalidation(
    registration: CoherentCacheRegistration,
    scope: 'group' | 'epoch',
    group: string,
  ): void {
    if (scope === 'epoch') registration.applyRemoteInvalidation()
    else registration.applyRemoteInvalidationForGroup(group)
  }
}

function mergeGeneration(state: GroupState, cacheName: string, generation: number): void {
  const current = state.generations.get(cacheName) ?? 0
  if (generation > current) state.generations.set(cacheName, generation)
}
