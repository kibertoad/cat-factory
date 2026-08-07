# layered-loader: upstream gaps observed while building the Worker pull-coherency pilot

Notes for the upstream [`layered-loader`](https://github.com/kibertoad/layered-loader)
library, collected while implementing caching-layer slice 11 (the Cloudflare pull-coherency
mechanism; see `docs/initiatives/caching-layer.md`). The 16.0/16.1 releases carried exactly
the primitives the slice needed (`/core` entrypoint, `applyRemoteInvalidation*`,
`scheduleBackgroundWork`), so each item below is grounded in the code this repo still had to
hand-roll around them, as candidates for a first-class home upstream.

## 1. A first-class pull-coherency option on `LoaderConfig`

The 16.1 apply-remote primitives are the bottom half of the README's own edge-runtime
recipe (pull invalidations via generation counters). The top half is entirely hand-rolled
here as `@cat-factory/caching`'s `GroupGenerationTracker`
(`backend/packages/caching/src/generationCoherency.ts`): per-group probe-window
bookkeeping, last-seen generation baselines, coalescing concurrent probes onto one
in-flight read, monotonic compare (a lower-than-baseline read is a store read racing your
own bump, not a change), self-echo suppression via max-merging the bump's returned
generation, and the fail-closed-read / fail-open-write error posture. None of that is
app-specific, while the fence it triggers lives inside the loader. A config shape like

```ts
coherencyProbe: {
  getGenerations(group: string): Promise<Record<string, number>>
  windowMsecs: number
}
```

(or a `PullNotificationConsumer` sibling of `AbstractNotificationConsumer`) would let a
host wire the store and nothing else. The one design decision worth carrying over: the
batched per-group read is what makes the probe affordable when several loaders share group
strings, which suggests the primitive belongs at a multi-loader level rather than on one
loader, the same way the notification pair factory is per cache but the probe wants to be
per group.

## 2. An extractable `@layered-loader/cloudflare` adapter package

Three pieces of this implementation are app-independent and nearly verbatim reusable,
matching the shape of the existing `@layered-loader/sqs` adapter package:

- `CacheGenerationDirectory`
  (`backend/runtimes/cloudflare/src/infrastructure/durable-objects/CacheGenerationDirectory.ts`):
  a sqlite Durable Object of name-keyed monotonic counters behind `GET /generations` +
  `POST /bump`, sharded `idFromName(group)`, safe without transactions because the DO
  input gate serializes the read-modify-write.
- The fetch-RPC store client (`DurableObjectCacheGenerationStore` in
  `backend/runtimes/cloudflare/src/infrastructure/appCachesHost.ts`).
- The `scheduleBackgroundWork` adopter reading the current invocation's
  `ExecutionContext` off an `AsyncLocalStorage` and handing the promise to
  `ctx.waitUntil` (`requestContext.ts`), which is the README's own recommended pattern,
  shipped as code.

## 3. Publisher-without-consumer ergonomics

A pull-coherent writer is publish-only: it bumps a directory and consumes by probing, so
the consumer half of a notification pair structurally cannot exist (an isolate holds no
subscription). Riding the existing notification seam for the bump half was evaluated and
rejected for three reasons that are all upstream API shape:

- the pair types and `createGroupNotificationPair` assume both halves exist;
- loader-internal publishes run through `runInBackground` (fire-and-forget with errors
  routed to the publisher's error handler), while an after-commit bump wants to be awaited
  by the write path;
- the publish callbacks return `void`, while self-echo suppression needs the NEW
  generation flowing back to the caller.

A supported publish-only mode (or the pull primitive of item 1, which subsumes this) would
close the gap.

## 4. `AbstractGroupCache` lacks `applyRemoteInvalidationForMany`

The flat cache has `applyRemoteInvalidationForMany(keys)`; the group surface has only the
single-key, whole-group and whole-cache forms. Harmless for this repo (group-level
invalidation is the unit here), but a keyed pull transport that reads "these five keys
changed since cursor N" has no batched group form to apply it with.

## 5. `BackgroundWorkMeta.cacheId` is undefined for loaders without an in-memory tier

`cacheId` lives on `inMemoryCacheConfig`, so a pass-through loader (in-memory tier
disabled, as this repo's isolate-safe profile configures) reports
`cacheId: undefined` for its notification publishes, and a host adopting that work cannot
attribute it. A loader-level id, independent of whether the in-memory tier exists, would
fix the attribution and also give error handlers a stable name.

## 6. In-flight load coalescing has no per-request scope on isolate runtimes

`scheduleBackgroundWork` (16.1) solves the promises the loader starts and does not await.
It leaves the ones it awaits and SHARES: `AbstractGroupCache.getAsyncOnlyResolved` returns
an existing `runningLoads` entry to any caller asking for the same key, and `runningLoads`
belongs to the loader.

Those two facts do not compose on Cloudflare. The `BackgroundWorkScheduler` docs correctly
require the loader to be built at isolate scope ("a loader rebuilt per request is a memo,
not a cache"), but at isolate scope the loader outlives every request, so on a same-key
miss request B is handed a promise created while serving request A. Workerd's answer is to
DESTROY B with "Cannot perform I/O on behalf of a different request", raised at the runtime
level where B's own `try`/`catch` cannot see it, so the symptom is a request whose work
silently never completes rather than an error anyone can route.

This repo works around it by not using the loader's load path on that runtime at all: a
read serves from `getInMemoryOnly` and a miss loads out of band, coalesced against a
host-supplied invocation identity and published with `forceSetValueForGroup` behind a
locally-held fence (`backend/packages/caching/src/invocationScopedLoads.ts`). The fence is
the part that most wants to be upstream: `forceSetValueForGroup` is not guarded by
`backgroundWriteFences`, so an out-of-band publish has to re-implement the resurrection
protection the loader already owns for its own load path.

What would close it, roughly in order of preference:

1. A `loadScope?: () => object | undefined` (or similar) on `CommonCacheConfig`, so
   `runningLoads` is keyed by `(scope, key)` and cross-request joins simply cannot form.
   The same scope would apply to any other shared in-flight state the library grows.
2. Failing that, a documented `coalesceLoads: false`, which trades the dedup for safety and
   at least keeps hosts on the library's own load path.
3. Either way, a FENCED public set (`forceSetValueForGroup` honouring the background write
   fences, or a variant that does), so a host that must publish out of band is not
   re-implementing invalidation safety from outside.

Worth noting for the docs regardless: the `BackgroundWorkScheduler` note explains the
isolate-scope requirement and the `waitUntil` adoption, and a reader reasonably concludes
that adopting background work is the whole edge-runtime story. The load-coalescing half is
the sharper hazard and is currently unmentioned.
