---
'@cat-factory/kernel': minor
'@cat-factory/contracts': minor
'@cat-factory/integrations': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
---

Route platform-health alerts to the workspace's outbound webhook as their own event family, so
on-call tooling can be paged by the deployment watching itself.

A workspace's registered endpoint gains an `alertEvents` filter beside `types` and `runEvents`,
carrying `platform_health.firing` when the health sweep's set of tripped conditions changes and
`platform_health.resolved` when it observes the account recover. Empty means none, like
`runEvents`: subscribing a receiver to alerts is always explicit.

The `platform_health` notification CARD could already be named in the `types` filter, and for a
human overseer it still should be. It is not safe to page on: a card is re-delivered when a human
acts on it or dismisses it, which is indistinguishable on the wire from the sweep clearing it
because the deployment recovered. These edges come from the sweep's own verdict, and carry each
condition's observed value and threshold (which the card deliberately omits, since its payload is
its dedup identity).

Each delivery is identified by `<cardId>:<event>:<transition>[:<reasons>]`, where the transition
ordinal is counted on the card row itself. Neither simpler key works: a condition set recurs within
one incident (`{A}` → `{A,B}` → `{A}`), so keying on the set drops the page saying it subsided,
while keying on a timestamp pages twice whenever two of the deployment's sweepers observe one
transition. `occurredAt` is the sweep's own observation of the transition rather than anything read
off the card, whose `createdAt` is preserved across a re-raise and so names when the incident
opened.

Internal break: `NotificationWebhookRecord` gains a required `alertEvents` field, and the
`notification_webhooks` table gains an `alert_events` column on both runtimes. Existing rows
default to `[]`, so every registered endpoint keeps its current behaviour byte-for-byte.

The `platform_health` notification payload gains an optional `platformAlertTransition`, which
carries that ordinal and so also lets a caller reading `GET /api/v1/notifications` line a card up
against the alert deliveries it received. That is an ADDITIVE public-API change: the OpenAPI
`info.version` goes to 1.1.0 and the four SDK clients plus the MCP facade regenerate, with no
existing field renamed, retyped or removed. A card written before this ships carries no ordinal and
its next transition simply starts the count at 1.
