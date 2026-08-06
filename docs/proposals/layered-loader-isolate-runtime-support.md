# Proposal (upstream, `layered-loader`): support caching on isolate runtimes with no invalidation bus

**Status:** draft, not yet filed upstream · **Date:** 2026-08-06 ·
**Target:** [`layered-loader`](https://github.com/kibertoad/layered-loader) ≥ 16 ·
**Downstream driver:** [`docs/initiatives/caching-layer.md`](../initiatives/caching-layer.md)

This is a proposal we intend to file against `layered-loader` itself. It is written to stand alone:
a reader in that repo should not need any cat-factory context. Everything asked for here is
additive and opt-in, with today's behaviour as the default.

## How we use the library

One in-memory tier per process (`GroupLoader` with `inMemoryCache`, `cacheType: 'lru-object'`), no
async cache tier ever. Redis appears only as an **invalidation bus**: `createGroupNotificationPair`
broadcasts keys, each replica repopulates from its own database. Values never ride the wire. Every
write path calls `invalidateCacheFor*` after its transaction commits, so the TTL is a freshness
backstop rather than the coherence story.

That model works on Node. It has no shape at all on the runtime described below, and we would
rather extend the library than build a second caching seam beside it.

## The runtime that does not fit

Cloudflare Workers, and by extension any target made of many short-lived, mutually unreachable
instances (Deno Deploy, Vercel edge, Lambda@Edge, aggressively-scaled serverless Node):

1. **No pub/sub any instance can reach.** There is no Redis, and no broadcast primitive that
   delivers to arbitrary isolates. The `notificationPairFactory` seam is perfectly designed and
   simply has nothing to be implemented over.
2. **Nothing can hold a subscription.** An isolate only runs inside a request; it cannot keep a
   socket open between requests waiting to be told something. Push is structurally unavailable, so
   the answer has to be pull.
3. **I/O is scoped to the request that created it.** Work started during request A and still
   running after A responds fails with `Cannot perform I/O on behalf of a different request` unless
   it was handed to `ctx.waitUntil()`. Any fire-and-forget promise the library creates is exposed
   to this.
4. **Instances are numerous and cold.** A cache that only fills within one invocation is a memo,
   not a cache.

The consequence for us today: our Worker profile marks 14 of 17 caches pass-through
(`enabled: false`), because a TTL'd entry over mutable shared state with no way to invalidate it is
a correctness bug rather than an optimization. Only the three self-verifying caches stay on, and
they are exactly the ones that carry a cheap version probe: a document `version` token, a git branch
head sha, an SSO discovery document that self-heals on an unknown key id.

**That is the pattern we want to generalise.** Where there is no bus, a cheap probe against a
version token is the coherence mechanism, and `isEntryStillCurrentFn` is already almost the right
primitive. The asks below are what stands between "almost" and "yes".

## What we can already do without any library change

Stated up front so the asks stay honest and narrow:

- **Hoisting the cache bag to isolate scope** so it outlives one invocation. Purely our bug; we
  build it per request today.
- **Reading a per-tenant mutation generation counter** from a Durable Object or a single row, once
  per invocation, memoised, and feeding it to `isEntryStillCurrentFn` as the probe. This is the
  pull-based bus, and it needs nothing from the library.
- **Draining pending invalidations at request start** by calling `invalidateCacheForGroup`
  ourselves, if we prefer that to a probe.

So the gaps are not "we cannot integrate". They are three specific behaviours.

## Ask 1 (the load-bearing one): a blocking, every-hit validation mode

### Current behaviour, as we understand it

`isEntryStillCurrentFn` fires **only** when a hit lands inside `ttlLeftBeforeRefreshInMsecs`, and
the resulting work is **background**: the read that triggered it is served the cached value
regardless, with `true` bumping the TTL and `false`/throw scheduling a reload for whoever reads
next. In HTTP-cache terms the library implements `stale-while-revalidate`.

(If any part of that is wrong, this ask may shrink to a documentation fix, and we would rather be
corrected than shipped a feature.)

### Why that is not enough

`stale-while-revalidate` is exactly right for content: a slightly-late fragment body or repository
file costs nothing. It is not right for a decision. The caches we cannot enable on Workers are
authorization and policy reads: a resolved workspace access decision, a merge-risk policy, a model
preset. For those, serving one known-stale answer is the failure. A revoked member keeping read
access until the next refresh window is not a latency trade, it is the bug.

Every one of them would be safely cacheable with a probe against a generation counter, because the
probe is one cheap read replacing several expensive ones. What is missing is the guarantee that the
read **waits** for the probe.

### Proposed API

Split the two orthogonal decisions that are currently fused into one option:

```ts
new GroupLoader({
  inMemoryCache: { /* … */ },
  isEntryStillCurrentFn,
  // NEW, both optional; omitting either preserves today's behaviour exactly.
  validation: {
    when: 'refresh-window', // default (today) | 'every-hit'
    mode: 'background',     // default (today) | 'blocking'
  },
})
```

`{ when: 'every-hit', mode: 'blocking' }` is `must-revalidate`: no hit is served without the probe
having answered. `{ when: 'refresh-window', mode: 'background' }` is today, unchanged, and stays the
default. The two remaining combinations are coherent and cheap to fall out of the implementation,
but we have no use for them and would not object to them being rejected at construction.

### Semantics we would want pinned

| Case                                     | Proposed behaviour under `blocking`                                       |
| ---------------------------------------- | ------------------------------------------------------------------------- |
| Probe resolves `true`                    | Serve cached, bump TTL. No load. (Same as today, minus the background hop.) |
| Probe resolves `false`                   | Await the load, serve the fresh value.                                      |
| Probe throws                             | Treat as stale: await the load. If the load also throws, propagate.         |
| No probe passed for this read            | Treat as stale (the current degrade-to-reload rule), not as a silent hit.   |
| N concurrent `get`s, same key            | **One** in-flight probe, shared, like the load's existing dedup.            |
| Entry absent                             | Ordinary miss. The probe never runs against nothing.                        |
| Cached value is `null`                   | Reload rather than probe (matches the current guard).                       |

The concurrency row is the one we care about most and the one we suspect is not true today: we
memoise our git head-sha probe by hand in our own wrapper precisely because a burst of reads over
one branch otherwise issued a probe each. If the loader coalesced probes the way it coalesces
loads, that hand-rolled memo would go away, on Node as well as on Workers.

### Not a Cloudflare-specific request

Any deployment where a cheap version probe exists and staleness is a correctness problem wants
this: a multi-replica Node deployment that would rather validate than wire a bus, a single process
whose source is written by something other than itself, a test that needs deterministic freshness.
The isolate runtime is what makes it unavoidable, not what makes it useful.

## Ask 2: a hook for work the loader does not await

### The failure mode

Anything the library starts and does not await (a background refresh, a notification publish) is a
promise that can outlive the request that created it. On workerd that is not merely untracked, it
faults: `Cannot perform I/O on behalf of a different request`. The host has exactly one correct
response, `ctx.waitUntil(promise)`, and no way to reach the promise to apply it.

Today this is masked for us only because we rebuild the cache per invocation. Fixing our lifetime
bug (which we must) exposes it.

### Proposed API

```ts
new GroupLoader({
  // NEW, optional. Default: `void work` — today's behaviour, byte for byte.
  scheduleBackgroundWork: (work: Promise<unknown>, meta: { cacheId: string; reason: string }) =>
    ctx.waitUntil(work),
})
```

Every fire-and-forget promise goes through it. `meta.reason` need only be a small closed set
(`'refresh'`, `'notification'`, whatever else exists) and is for the host's logging, not for
control flow.

Two beneficiaries beyond the edge case: tests get a way to await quiescence instead of sleeping,
and a Node shutdown path gets a way to drain in-flight refreshes before closing. Note that if Ask 1
lands and a host chooses `blocking` validation, that host may have no background work left at all,
which is why this is second priority rather than first.

## Ask 3 (lowest, possibly a docs change): applying an invalidation from a pull transport

Push is unavailable on these runtimes, so the notification-consumer abstraction cannot be
implemented. The equivalent is a host that reads "what changed since cursor N" at request start and
applies it. We believe we can do that entirely with the public `invalidateCacheFor` /
`invalidateCacheForGroup` methods, and we are not asking for a new transport.

What would help is a stated position on whether calling those methods from outside the loader's own
notification machinery is a **supported** way to apply a remote invalidation, or an accident of the
public surface. If supported, a paragraph in the README is the whole ask. If a pull-shaped consumer
abstraction is something you would rather own (`consumer.drain()`, called by the host), we would
use it, but we would not build it speculatively.

## Explicit non-asks

- **An async cache tier over Cloudflare KV, D1 or Durable Object storage.** We do not want values
  on a wire, and KV's write propagation makes it a worse coherence story than reading our primary
  database. Our stance that Redis is a bus and never a data tier is deliberate, and this does not
  soften it.
- **A Cloudflare-specific package or adapter.** Everything above is runtime-neutral. The host
  supplies the probe and the scheduler; the library never learns what a Worker is.
- **Anything that changes a default.** See below.

## Compatibility

All three are additive and opt-in. A caller passing none of the new options gets today's behaviour
unchanged, including the existing rejection of `isEntryStillCurrentFn` without a refresh window
(under the proposal, `when: 'every-hit'` becomes the second legal way to have a window in which the
probe can fire).

## Open questions for the maintainer

1. Is the every-hit/blocking behaviour genuinely absent today, or reachable via a configuration we
   have missed? Our reading of it is stated above and may be out of date.
2. Are concurrent `isEntryStillCurrentFn` calls for one key already coalesced? Our hand-rolled
   probe memo assumes not.
3. Does the in-memory-only loader schedule anything on a timer (eviction sweep, refresh tick)?
   Timers behave differently under workerd, and a periodic one in a hot path would be worth knowing
   about even though our Worker conformance run has not tripped on it.
4. Would you prefer these as independent options, or as one named preset for the
   no-invalidation-bus deployment shape?
