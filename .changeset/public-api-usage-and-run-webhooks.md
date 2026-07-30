---
'@cat-factory/contracts': patch
'@cat-factory/kernel': patch
'@cat-factory/integrations': patch
'@cat-factory/orchestration': patch
'@cat-factory/server': patch
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
from `insertLiveRunOrConflict`, the one funnel that mints a live run and whose insert is the atomic
claim, so it is exactly once and a start path added later inherits it. The terminal edges fire from
the engine's terminal-emit funnel, because a run reaches `done` from four independent sites and a
hook at each would compile, pass, and drift the day a fifth is added — the cost is that a durable
replay can re-emit a settled run, so delivery is **at-least-once** with a `<runId>:<event>` dedupe
id in the body. That is a considered departure from the platform's atomic-claim rule: a repeat here
is byte-identical, unlike a merge or a posted review, so it does not earn a claim table and the
sweeper that would come with it.

Schema: `notification_webhooks` gains a `run_events` JSON column (D1 migration 0072 ⇄ Drizzle),
defaulting to `'[]'`. The webhook repository is now read on the run's terminal path, so it is
allow-listed for mothership mode (`get`/`put`/`delete`, workspace-scoped) — an un-routed method
there would have surfaced only as a webhook that silently never fires, since both delivery paths
are best-effort by contract.
