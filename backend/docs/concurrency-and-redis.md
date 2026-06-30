# Concurrency control & the Redis question

This note records how the backend handles concurrent writers and **why Redis is
deliberately not part of the stack today** — so the trade-off is captured rather than
re-litigated. It accompanies the three race-condition fixes that introduced
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
  TTL, and to stay correct across TTL expiry it needs a **fencing token** — which is
  exactly the monotonic `rev` column. Redis would add a stateful dependency _and still_
  need the version column. It is also asymmetric: Cloudflare's natural per-id
  coordination primitive is a **Durable Object** (already used by `WorkspaceEventsHub`),
  not Redis.
- **Key lease.** A single atomic SQL statement is correct on both databases without new
  infrastructure. Redis (a Lua `EVAL` pick-and-mark, sorted sets) only wins for
  _cross-instance global rate-limiting / token buckets_ — a separate, larger goal.
- **Notification dedup.** A partial unique index is durable and simpler than a Redis
  `SETNX` guard.

The general principle: when the invariant lives next to the data, enforce it **in the
database** (a version column, `FOR UPDATE SKIP LOCKED`, a unique index). That keeps the
two runtime facades symmetric (D1 ⇄ Postgres) and adds no operational surface.

## Where Redis _would_ genuinely fit (future, out of scope)

Two scaling concerns are the legitimate Redis use-cases, both **Node-only** (Cloudflare
keeps Durable Objects):

1. **Multi-replica real-time fan-out.** The Node real-time hub is single-process today
   (`runtimes/node/src/realtime.ts`: "a multi-replica deployment would front the hub
   with Postgres LISTEN/NOTIFY"). Redis **pub/sub** is the canonical alternative to
   LISTEN/NOTIFY for cross-replica WebSocket broadcast. A horizontally-scaled Node
   deployment is also what makes the lost-update races _more_ frequent — the CAS fix
   above already covers correctness there; Redis would only be about delivery fan-out.
2. **Global API-key rate-limiting.** A Redis token-bucket would coordinate rate limits
   across replicas, beyond the per-database atomicity the lease fix provides.

Neither is needed for correctness today, and neither changes the database-native
decisions above. Revisit only when a multi-replica Node deployment is actually on the
table.
