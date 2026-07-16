# Initiative: durable cross-replica auth rate limiting

**Status:** planned (tracker only — no slices landed) · **Owner:** core · **Started:** 2026-07-16

> Durable source of truth for a multi-PR initiative. Read it first before picking up the
> next slice; update the checklist at the end of each PR.

## Goal & rationale

Brute-force protection on the password endpoints (`register`, `login`, `request-reset`,
`reset-password`) is `passwordAttemptLimited`
(`backend/packages/server/src/modules/auth/AuthController.ts`) — a **module-global
in-process `Map`** of recent attempt timestamps. The code's own comment is explicit: the
window is per-isolate, so it is "a speed bump, not an authoritative limiter — a durable,
cross-runtime limiter (D1/Postgres-backed, exercised by the conformance suite) is the
proper follow-up." Concretely:

- On a horizontally-scaled Node deployment every replica keeps its own window: effective
  attacker throughput is `MAX_ATTEMPTS × replicas`, and a rolling deploy resets all of it.
- On Workers, each isolate has its own Map — the same multiplication, worse churn.
- It is also the exact class of hand-rolled in-memory state the caching rule bans for
  shared mutable data, applied to a **security boundary**.

Neither security-hardening tracker covers this. This initiative implements the promised
durable limiter. (`backend/docs/concurrency-and-redis.md` notes cross-replica rate limiting
was consciously out of scope for the Redis work — the durable-store approach here does not
need Redis.)

## Target pattern

1. **Kernel port**: an `AuthAttemptRepository`-shaped port — the honest minimal surface is
   `countRecent(key, sinceMs)` + `record(key, atMs)` + `deleteOlderThan(epochMs)` (the
   retention shape every telemetry-ish table here uses). Keying stays exactly as today:
   `clientIp:email` for the email endpoints, the fixed `reset-password` bucket for token
   redeem (per the in-code rationale — do NOT key redeem attempts by token value).
2. **Implementations**: a small `auth_attempts` table, D1 ⇄ Drizzle (+ migrations both
   sides), with a **conformance assertion** driving over-limit behaviour against both
   stores — the port comment literally requests this.
3. **Enforcement**: `passwordAttemptLimited` becomes an async check through the port.
   Fail-closed question is real: if the store errors, keep the current in-process Map as
   the fallback layer (belt over braces) rather than silently allowing — the Map code
   stays, demoted from "the limiter" to "the backstop when the store is unreachable".
4. **Retention**: attempts are junk minutes later — hook `deleteOlderThan` into the
   existing retention sweeps (Worker cron ⇄ Node timer), aggressive window.
5. **Write cost discipline**: one read + one write per password attempt is acceptable on
   these endpoints (they are rare and PBKDF2-priced); do NOT extend this table to
   high-frequency routes — a general API rate limiter is a different problem with a
   different design (and explicitly out of scope here).

## Prioritized checklist

| # | Slice | Status | PR |
| - | ----- | ------ | -- |
| 1 | Kernel port + `auth_attempts` D1 ⇄ Drizzle impls + migrations | ⬜ todo | |
| 2 | Conformance assertions: over-limit 429 behaviour on both runtimes; window expiry | ⬜ todo | |
| 3 | `AuthController` switch to the durable check (Map demoted to store-failure backstop) | ⬜ todo | |
| 4 | Retention sweep wiring (both runtimes) | ⬜ todo | |
| 5 | Config: window/limit env knobs with today's constants as defaults | ⬜ todo | |

## Conventions & gotchas

- **Keying rationale is load-bearing** — read the existing comments before changing keys:
  per-IP+email prevents one attacker locking out a victim; the reset-redeem endpoint must
  NOT be keyed by token value (every guess would mint its own bucket and limit nothing).
- **Never leak which arm limited** — the 429 response stays identical across endpoints and
  causes (no "this email is being attacked" oracle).
- **Don't reach for Redis** — the durable store both runtimes already have IS the
  cross-replica coordination point; Redis-based limiting was already considered and
  deferred in `concurrency-and-redis.md`.
- **Count-then-record ordering**: record the attempt before verifying the password (a
  failed verify must still have been counted), and don't bother "refunding" successful
  logins — the window is short and refunds add a write for no security value.
- This is small enough for one PR + a config follow-up; it's tracked because it is a
  security-boundary change that must land runtime-symmetric with conformance coverage, not
  because it is large.
