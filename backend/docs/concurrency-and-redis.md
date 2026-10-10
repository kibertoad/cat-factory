# Concurrency control & the Redis question

This note records how the backend handles concurrent writers and **why the concurrency
fixes are database-native rather than Redis-based**, so the trade-off is captured rather
than re-litigated. (Redis does appear in the stack, but only as the opt-in multi-node
delivery bus; see "Where Redis fits" below.) It accompanies the three race-condition fixes that introduced
optimistic concurrency on execution runs, atomic API-key leasing, and notification
open-card dedup.

## The contention model

Long-running agent runs are written from **two independent writers at once**: the
durable driver (Cloudflare `ExecutionWorkflow` / Node `driveExecution` over pg-boss)
and human-action HTTP handlers (resolve decision, approve, request changes, …). Both
followed the same `get → mutate whole instance → upsert` shape with a blind write, so
the last write won and the other writer's mutation was lost.

The fixes are **database-native**, not coordination-service-based:

| Hazard                      | Fix                                                          | Mechanism                                               |
| --------------------------- | ------------------------------------------------------------ | ------------------------------------------------------- |
| Lost update on a run        | `agent_runs.rev` + `compareAndSwap` + `mutateInstance` retry | optimistic concurrency (CAS)                            |
| Double-leased API key       | `leaseLeastUsed` select-and-mark                             | PG `FOR UPDATE SKIP LOCKED`; D1 single serialised write |
| Duplicate open notification | partial unique index + `upsertOpenForBlock`                  | `ON CONFLICT … WHERE status='open'`                     |

## Why not Redis for these fixes

Redis was evaluated for each and is **not** the right tool:

- **Lost updates.** A Redis distributed lock around a multi-second run-advance needs a
  TTL, and to stay correct across TTL expiry it needs a **fencing token**, which is
  exactly the monotonic `rev` column. Redis would add a stateful dependency _and still_
  need the version column. It is also asymmetric: Cloudflare's natural per-id
  coordination primitive is a **Durable Object** (already used by `WorkspaceEventsHub`),
  not Redis.
- **Key lease.** A single atomic SQL statement is correct on both databases without new
  infrastructure. Redis (a Lua `EVAL` pick-and-mark, sorted sets) only wins for
  _cross-instance global rate-limiting / token buckets_, a separate, larger goal.
- **Notification dedup.** A partial unique index is durable and simpler than a Redis
  `SETNX` guard.

The general principle: when the invariant lives next to the data, enforce it **in the
database** (a version column, `FOR UPDATE SKIP LOCKED`, a unique index). That keeps the
two runtime facades symmetric (D1 ⇄ Postgres) and adds no operational surface.

## Inline LLM concurrency limiting (in-process, per vendor)

Inline (non-container) LLM calls resolve a model through the `ModelProvider` seam and
call the AI SDK directly. A burst of them (a consensus fan-out, the requirements
recommendation writer, a sandbox sweep) can hammer a subscription vendor. A
`VendorConcurrencyLimiter` (`@cat-factory/agents`) caps how many inline calls to a
subscription/shared-pool vendor (`claude` / `codex` / `glm` / `kimi` / `deepseek`) run at
once. It is a `LimitedModelProvider` decorator (sibling to `InstrumentedModelProvider`),
applied as the OUTERMOST resolver wrap in each facade via `wrapResolverWithLimiter`, keyed
by `subscriptionVendorForRef(ref)`. Everything else (your own OpenAI/Anthropic API keys,
Cloudflare, local runners) passes through uncapped. Both the buffered and streaming inline
paths are gated (a stream holds its permit until it ends), and a queued call whose request is
aborted releases its slot rather than head-of-line blocking. Configured by
`LLM_SUBSCRIPTION_MAX_CONCURRENCY` (default 3 per vendor; `_<VENDOR>` overrides that one vendor
and always wins). Any value `<= 0` is uncapped, so a default of `0` uncaps every vendor without
an explicit per-vendor override; leave the overrides unset too to turn the feature off entirely.

This is **in-process only**: one limiter per Node process (per container/tenant) or per
Worker isolate, which is exactly the scope of a single inline fan-out. It is NOT global
rate-limiting: it bounds in-flight concurrency, not requests-per-minute, and does not
coordinate across replicas or isolates. On Node/Worker an inline subscription ref is
degraded to a pool/API-key provider before resolve, so the cap bites mainly in local mode
(the prewarmed-container inline subscription backend keeps the ref); elsewhere it is a
wired pass-through. Cross-replica/global rate-limiting stays out of scope, per below.

## Where Redis fits

Two scaling concerns are the legitimate Redis use-cases, both **Node-only** (Cloudflare
keeps Durable Objects). The first has since landed; the second stays out of scope:

1. **Multi-replica real-time fan-out (landed).** The in-process `NodeRealtimeHub`
   (`runtimes/node/src/realtime.ts`) is now fronted by the `LayeredEventPropagator`
   (`propagator.ts`) behind the narrow `LocalEventSink` seam, with Redis **pub/sub** as
   the shipped adapter (`redisPropagator.ts`, enabled by `REDIS_URL`; channel set by
   `REDIS_REALTIME_CHANNEL`). With no bus configured the layer is exactly the bare hub,
   so single-node and local deployments are unaffected. Horizontal scale is also what
   makes the lost-update races _more_ frequent; the CAS fix above covers correctness,
   and the propagator is only about delivery fan-out. The app-cache invalidation bus
   rides the same `REDIS_URL` (`cacheNotifications.ts`, see `@cat-factory/caching`).
2. **Global API-key rate-limiting (still future).** A Redis token-bucket would
   coordinate rate limits across replicas, beyond the per-database atomicity the lease
   fix provides.

The rate-limiting half is not needed for correctness today and does not change the
database-native decisions above; revisit it when a multi-replica Node deployment
actually needs coordinated limits.
