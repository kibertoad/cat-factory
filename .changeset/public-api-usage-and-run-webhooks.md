---
'@cat-factory/contracts': patch
'@cat-factory/kernel': patch
'@cat-factory/integrations': patch
'@cat-factory/orchestration': patch
'@cat-factory/server': patch
'@cat-factory/spend': patch
'@cat-factory/node-server': patch
'@cat-factory/worker': patch
'@cat-factory/conformance': patch
---

Finish the `/api/v1` external surface: a workspace usage read, and an outbound run-lifecycle push
so an integration stops polling.

`GET /api/v1/usage` (a `read`-scope key) serves the current billing period as ONE resource: the
METERED budget position the spend safeguard itself acts on — including `exceeded`, which is what
pauses runs — plus the per-`(billing, vendor, provider, model)` breakdown behind it. Splitting it
into two endpoints would let a caller render a breakdown against a budget read a period-roll apart.
It reads through a new `SpendService.periodUsage`, which resolves ONE `periodStart` for both
aggregates and still issues them concurrently: composing the response from `status()` +
`usageBreakdown()` would have reintroduced the same skew inside one request, since each derives its
own period from the clock.
Rows keep their `billing` discriminator and are never summed for the caller: a `subscription` row's
`costEstimate` is illustrative (a flat-rate plan bills nothing per token), so adding it to metered
spend would report money nobody is billed for. Workspace tier only — the account and user budgets
are cross-workspace, and a workspace-scoped key must never learn a sibling workspace's spend.

The workspace's ONE registered outbound endpoint now also delivers run-lifecycle events —
`run.started`, `run.completed`, `run.failed` — beside the notification cards it already carried,
reaching the transport through a new kernel `RunLifecycleSink` port. This exists because the HAPPY
path raises no notification at all: a pipeline whose `merger` merges its own PR settles with an
empty inbox, which is exactly the outcome a CI system wants to hear about. Same row, same sealed
secret, same SSRF guard, same retry budget: the retry/signature/redirect core moved to a shared
`signedDelivery.ts` that both families drive, because everything interesting about a delivery is a
property of the endpoint rather than the payload.

**Subscribing is opt-in and empty means NONE**, deliberately the opposite of the sibling
notification `types` filter — an endpoint registered for parked decisions must not silently start
receiving an event per run — so an existing webhook keeps byte-for-byte its current behaviour until
someone sets `runEvents`.

Worth knowing when reviewing: the two edges hook different places on purpose. `run.started` fires
from `handOffLiveRun`, the one funnel every start path ends with, and is announced LAST — after the
block is committed and the durable runner has the run — so a slow or black-holing receiver costs the
announcement and never the run. It is still exactly once, because the claim that precedes the
hand-off (`insertLiveRunOrConflict`) is what mints a live run, and a start path added later inherits
it since skipping the funnel would also skip `startRun`. The terminal edges fire from the engine's
terminal-emit funnel, because a run reaches `done` from four independent sites and a hook at each
would compile, pass, and drift the day a fifth is added — the cost is that a durable replay can
re-emit a settled run, so delivery is **at-least-once** with a `<runId>:<event>` dedupe id in the
body. **Dedupe on that id, not on the body**: a replay re-stamps `sentAt`/`occurredAt`, so two
deliveries of one transition are not byte-identical even though everything a receiver routes on is.
That is a considered departure from the platform's atomic-claim rule: unlike a merge or a posted
review, a repeat here is collapsed by one id comparison, so it does not earn a claim table and the
sweeper that would come with it.

`docs/openapi.json` shrinks by ~17k lines in the same change, with no semantic difference beyond
the new endpoint. The generator copied every component definition into a `$defs` block on each
schema it inlined, so the whole component set was duplicated across ten operations and every new
public DTO cost roughly ten times its size in the committed file. Those `$defs` resolved nothing —
the refs are rewritten into `#/components/schemas` — and generation now asserts that every `$ref`
names an emitted component, so a DTO that actually needs hoisting fails the build instead of
shipping a dangling pointer.

Schema: `notification_webhooks` gains a `run_events` JSON column (D1 migration 0072 ⇄ Drizzle),
defaulting to `'[]'`. The webhook repository is now read on the run's terminal path, so it is
allow-listed for mothership mode (`get`/`put`/`delete`, workspace-scoped) — an un-routed method
there would have surfaced only as a webhook that silently never fires, since both delivery paths
are best-effort by contract.
