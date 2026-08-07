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
