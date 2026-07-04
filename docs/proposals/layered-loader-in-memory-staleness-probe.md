# Proposal: in-memory staleness probes for layered-loader (`isEntryStillCurrentFn` without an async tier)

**Status:** draft, for upstreaming to [`layered-loader`](https://github.com/kibertoad/layered-loader) ·
**Motivated by:** the caching initiative's git-backed slices
([`docs/initiatives/caching-layer.md`](../initiatives/caching-layer.md), rows 2 and 4) ·
**Analyzed against:** layered-loader `14.5.2`

## Summary

Allow `isEntryStillCurrentFn` on a loader whose only cache tier is the in-memory one, by
running the staleness probe from the existing in-memory refresh-ahead path and bumping the
in-memory entry's TTL when the probe reports the entry current. Today the probe is hard-gated
on an async cache tier, so an in-memory-only deployment can refresh ahead of expiry but must
always pay the FULL data-source reload — even when a probe a hundred times cheaper (a
commit-sha compare) could have proven the cached value still current.

## Where the gap is (14.5.2 behaviour, verified against the shipped source)

Two separate mechanisms exist today, and only one of them is available in-memory-only:

1. **In-memory refresh-ahead works.** `getInMemoryOnlyResolved` (on
   `AbstractCache`/`AbstractGroupCache`) checks the in-memory entry's expiration on every hit; inside
   `inMemoryCache.ttlLeftBeforeRefreshInMsecs` it fires a background `getAsyncOnlyResolved`,
   which — with no async tier configured — goes straight to `loadFromLoaders` (a full
   data-source reload) and re-seeds the in-memory entry. Callers keep being served the
   current value; the entry never hard-expires under steady reads. This needs no change.

2. **The cheap-probe path is async-only.** The `isEntryStillCurrentFn` machinery lives
   exclusively in `Loader`/`GroupLoader.resolveValue`/`resolveGroupValue`'s async-HIT
   branch: it fires only when the async tier returned a value, keys the refresh window off
   the ASYNC entry's expiration (`asyncCache.expirationTimeLoadingGroupedOperation`), and
   bumps freshness via `asyncCache.resetTtl`/`resetTtlFromGroup`. The constructor's
   `assertStalenessCheckSupported` throws when `isEntryStillCurrentFn` is configured
   without an async cache exposing the reset method.

Consequence: an in-memory-only loader in the refresh window always re-runs the full load,
even for sources whose staleness is decidable by a cheap version probe. For the cat-factory
use cases the "full load" is a GitHub directory re-list + per-file body refetch (or a
Confluence/Notion document refetch), while the probe is a single `latestCommitSha` /
content-hash compare — exactly the asymmetry `isEntryStillCurrentFn` exists to exploit.

## Why the downstream workarounds are unsatisfying

- **An always-miss async stub does not unlock the feature.** It satisfies the constructor
  assertion, but the probe branch requires an async HIT and reads the async entry's
  expiration — a stub that stores nothing never hits, so the probe never fires. Worse, it
  silently turns the feature into a no-op, the exact failure mode
  `assertStalenessCheckSupported` was added to prevent.
- **An in-process `GroupCache` adapter in the async slot works, but poorly.** Holding the
  durable copy in an in-memory implementation of the async-cache interface (fronted by a
  short-TTL sync in-memory tier) does make the probe machinery run verbatim. But it
  duplicates every entry across two tiers, gates probe cadence on front-tier misses (front
  TTL must be tuned well under the refresh window or entries hard-expire unprobed), forces
  implementing the full `Cache`/`GroupCache` surface including
  `expirationTimeLoadingOperation`, and — the sharp edge — **invalidation notifications
  evict only the front tier** (`AbstractNotificationConsumer.setTargetCache` targets the
  in-memory cache), so a peer's async-slot copy survives a broadcast eviction and is
  re-served on the next front miss. That confines the workaround to probe-driven caches and
  makes it a misuse trap for invalidation-driven ones.

Both workarounds re-implement, outside the library, a behaviour the library's own
primitives are one small step away from providing.

## Proposed change

No new configuration surface. The existing pair of `inMemoryCache.ttlLeftBeforeRefreshInMsecs`
and `isEntryStillCurrentFn` simply becomes a supported combination:

1. **Relax `assertStalenessCheckSupported`.** Accept `isEntryStillCurrentFn` when EITHER an
   async cache with `resetTtl`/`resetTtlFromGroup` is configured (today's rule) OR the
   in-memory cache is enabled with a `ttlLeftBeforeRefreshInMsecs`. Keep throwing when
   neither holds — the fail-fast is the right call.
2. **Route the in-memory refresh-ahead through the probe.** In the
   `getInMemoryOnlyResolved` window branch (today: `void this.getAsyncOnlyResolved(...)`),
   when `isEntryStillCurrentFn` is configured and the async tier is not the probe's home
   (no async cache, or no async refresh window), call the existing
   `refreshOrBumpTtl`-shaped flow with the IN-MEMORY cached value instead of the blind
   background reload:
   - probe returns `true` → bump the in-memory entry's TTL;
   - probe returns `false`, throws, or the bump fails → fall through to the full
     background reload (existing semantics: errors route to `loadErrorHandler` /
     `cacheUpdateErrorHandler`, worst case degrades to today's behaviour).
3. **In-memory TTL bump.** Give `InMemoryCache`/`InMemoryGroupCache` a
   `resetTtl(key)` / `resetTtlFromGroup(key, group)` returning `boolean`, mirroring the
   async contract. The implementation can be a re-`set` of the same value — the codebase
   already relies on a re-set resetting the toad-cache TTL (see the comment inside
   `refreshOrBumpTtl`: "getAsyncOnly already re-set the in-memory entry … which reset its
   TTL") — or a native toad-cache expiry touch if one is preferred. `false` when the entry
   vanished meanwhile (expired / invalidated), which correctly forces the full reload.
4. **Stampede control.** Reuse the existing refresh guards so concurrent hits inside the
   window schedule one probe, not many: the flat loader's `isKeyRefreshing` set and the
   group loader's `groupRefreshFlags`, exactly as the async probe path does today. (The
   current in-memory refresh-ahead only checks `runningLoads`, which dedups the reload but
   not the window check itself; the probe path should adopt the same flag discipline as
   the async branch.)
5. **Precedence when both tiers are configured: async wins, unchanged.** If an async cache
   with a refresh window is present, the probe keeps running only in the async-hit branch
   exactly as today — the in-memory probe activates solely for loaders where the async
   path cannot serve it. This keeps the change purely additive: no existing configuration
   changes behaviour.

Non-breaking; a minor release. Documentation change: the README's staleness-check section
drops the "requires an async cache" constraint and documents the in-memory variant.

## Semantics notes

- **The freshness guarantee is unchanged.** The probe still runs only inside the refresh
  window; between probes the guarantee is the TTL, same as the async variant and same as
  any hand-rolled TTL cache. A bump extends in-memory freshness by exactly one `ttlInMsecs`.
- **Probe cost contract is unchanged.** `isEntryStillCurrentFn` must be strictly cheaper
  than the load; nothing about running it against the in-memory value alters that.
- **Notifications interact correctly.** A broadcast invalidation deletes the in-memory
  entry; a subsequent bump attempt returns `false` (entry gone) and the flow falls through
  to a fresh load — no resurrection of invalidated values, matching the async path's
  "bump failed ⇒ treat as stale" rule.
- **`null` entries** (resolved-but-empty) flow through the probe like any cached value,
  as they do on the async path (`cachedValue: LoadedValue | null` is already the probe's
  first parameter type).

## Sketch (group variant; flat is symmetric)

```ts
// AbstractGroupCache.getInMemoryOnlyResolved — the window branch becomes:
if (expirationTime && expirationTime - Date.now() < this.inMemoryCache.ttlLeftBeforeRefreshInMsecs) {
  void this.scheduleInMemoryRefresh(key, group, loadParams) // was: void this.getAsyncOnlyResolved(...)
}

// GroupLoader.scheduleInMemoryRefresh — mirrors refreshOrBumpTtl, minus the async tier:
private async scheduleInMemoryRefresh(key, group, loadParams) {
  // groupRefreshFlags guard exactly as in resolveGroupValue's async branch
  const cachedValue = this.inMemoryCache.getFromGroup(key, group)
  if (
    this.isEntryStillCurrentFn &&
    cachedValue !== undefined &&
    (await this.isCurrentEntryTtlBumped(
      key,
      () => this.isEntryStillCurrentFn(cachedValue, loadParams, group),
      () => Promise.resolve(this.inMemoryCache.resetTtlFromGroup(key, group)),
    ))
  ) {
    return // still current — TTL bumped, no reload
  }
  const freshValue = await this.loadFromLoaders(key, group, loadParams)
  if (freshValue !== undefined) this.inMemoryCache.setForGroup(key, freshValue, group)
}
```

## Test cases to ship with it

- Probe `true` inside the window bumps the TTL and the data source is NOT called; the
  entry survives past its original expiry.
- Probe `false` triggers the full background reload; readers are never blocked and never
  see a gap.
- Probe throws → treated as stale (reload) and routed to `loadErrorHandler`.
- Bump on a vanished entry (invalidated between probe and bump) returns `false` → reload.
- Concurrency: N parallel hits inside the window run exactly one probe (flag guard).
- Constructor matrix: in-memory-only + window + probe = accepted; probe with neither tier
  refresh-capable = still throws; async-configured loaders behave byte-identically to today.
- Flat `Loader` and `GroupLoader` variants of all of the above.

## Downstream payoff (cat-factory)

With this in place, the caching initiative's slices 2 and 4 (git fragment-source /
doc-backed fragment bodies; `RepoFiles` branch-ref reads) run on plain in-memory-only
loaders: `isEntryStillCurrentFn` = one `latestCommitSha`/content-hash compare, full
GitHub/document refetch only when the upstream actually moved — replacing today's
hand-rolled `FragmentSourceService.status()` sha probe and the
`DEFAULT_DOCUMENT_FRAGMENT_TTL_MS` refetch cycle with the library primitive, with no
two-tier adapter and no notification-eviction caveat. It also keeps the initiative's core
rule intact on every runtime: in-memory only, Redis as an invalidation bus, never a data
tier.
