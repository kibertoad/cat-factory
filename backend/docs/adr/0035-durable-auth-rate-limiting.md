# ADR 0035: Durable cross-replica auth rate limiting

- **Status**: accepted
- **Date**: 2026-08-04
- **Context layer**: backend / auth

## Context

Brute-force protection on the password endpoints (`signup`, `login`, `forgot-password`,
`reset-password`) was a module-global in-process `Map` of recent attempt timestamps. The code's
own comment called it "a speed bump, not an authoritative limiter", and it was:

- **Multiplied by scale.** Every Node replica kept its own window, so effective attacker
  throughput was `MAX_ATTEMPTS x replicas`, and a rolling deploy reset all of it. On Workers each
  isolate has its own Map, which is the same multiplication with worse churn.
- **Blind to credential stuffing.** Keying on `ip:email` alone means one password sprayed across
  hundreds of emails leaves every bucket at 1. No per-key cap can see that pattern.
- **Spoofable.** The client address came from forwarded headers, so a rotating header value minted
  a fresh bucket per request, and a chosen value could pin a victim's bucket.

It was also the exact class of hand-rolled in-memory shared mutable state the caching rule bans,
applied to a security boundary.

## Decision

**The durable store both runtimes already have is the cross-replica coordination point.** A
kernel `AuthAttemptRepository` port over an `auth_attempts` table (D1 migration `0078` and the
Drizzle mirror) is the authoritative window, with a `defineAuthAttemptSuite` parity suite driving
both real stores.

Four decisions inside that shape carried the weight:

1. **Two caps, not one.** A per-`ip:email` burst cap (10 per 15 minutes) plus a per-IP aggregate
   across every bucket (50 per 15 minutes). The aggregate is the only thing that can see a
   one-password-many-emails sweep, and it is sized well above the per-key cap times a plausible
   number of users behind one NAT egress so a shared office address does not trip it in normal use.
2. **The in-process Map is demoted, not deleted.** It remains as the backstop when the store is
   unreachable, so an outage degrades to the old speed bump instead of failing open. Both of its
   buckets are ticked on every attempt, including when the store is healthy, so the backstop is
   already warm when it is needed.
3. **Record before counting, and never refund.** The attempt is written before any credential work,
   so a failed verify (or a crash mid-verify) has still been counted. Successful logins are counted
   too: the window is short, and a refund is a write for no security value.
4. **Which header carries the client address is a per-FACADE decision**, resolved through
   `ServerContainer.resolveClientAddress` rather than in shared throttle code. Node reads the socket
   peer, and `x-forwarded-for` only when `AUTH_TRUST_PROXY=true` (with `AUTH_TRUST_PROXY_HOPS`
   naming the chain depth, counted from the right). The Worker reads `cf-connecting-ip` alone.

## Rationale

**Why per-facade header resolution.** The first implementation put the header choice in the shared
throttle: with proxy trust enabled it preferred `cf-connecting-ip`, then the leftmost
`x-forwarded-for` hop. Both halves were wrong off Cloudflare. No generic reverse proxy (nginx,
Caddy, ALB, HAProxy) touches `cf-connecting-ip`, so on the very configuration the setting exists
for it stayed fully client-controlled; and under an appending proxy the leftmost hop is whatever
the client sent. Only the facade knows its own topology, so only the facade can answer. Node
therefore never reads the Cloudflare header, and the chain is read from the right, which is correct
under both the appending and overwriting proxy idioms.

**Why normalise the address.** A port-appending proxy would otherwise mint a bucket per connection,
and an attacker holding a routine IPv6 /64 would have 2^64 of them. Addresses are stripped of
ports, refused unless IP-shaped (so free text never becomes a bucket key or a ledger row), and
IPv6 is bucketed to its /64.

**Why no Redis.** Considered and deferred in `concurrency-and-redis.md`. The durable store needs no
new dependency and no new failure mode.

**Why no env knobs.** The tracker's fifth slice (window and limit as configuration) was dropped
deliberately. The constants hold until someone demonstrates a need; knobs now would be
configuration for its own sake. `AUTH_TRUST_PROXY`/`AUTH_TRUST_PROXY_HOPS` are not in that
category: they describe the deployment's topology, which the code cannot infer.

**Why the refusal is uniform.** One identical 429 across every endpoint and every arm, carrying
`details.reason: 'auth_attempts'` and `retryAfterSeconds`, so the response never becomes an oracle
for which limit tripped or which email is under attack. `Retry-After` is deliberately not set as a
header: the envelope survives every hop, headers do not.

**Keying rationale that must not be re-litigated.** Per-IP-plus-email prevents one attacker locking
out a victim by name. The reset-redeem endpoint is keyed by a FIXED bucket rather than the token
value, because keying by token would give every guess its own bucket and limit nothing.

## Consequences

- A trip and a store outage are both counted (`auth.throttle.limited`,
  `auth.throttle.store_unavailable`), not just logged: only a rate distinguishes one forgetful user
  from a sweep, and an outage that silently degrades every replica to a per-isolate window is
  invisible otherwise.
- Rows carry `ip:email` and are pruned by both facades' retention sweeps once past a one-hour age.
  Node sweeps hourly; the Worker sweeps on its daily retention cron, so a row can survive up to a
  day past that age there. Nothing about the throttle depends on the prune, which reads its own
  15-minute window.
- One read plus one write per password attempt. This table must NOT be extended to high-frequency
  routes: a general API rate limiter is a different problem with a different design.
- Two auth surfaces remain unthrottled and are known: PAT login and the invitation peek. Both are
  unauthenticated, and PAT login triggers a server-side VCS call per guess. They were outside this
  initiative's committed scope and are tracked in `security-hardening-round-2.md`.
