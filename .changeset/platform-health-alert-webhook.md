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

Internal break: `NotificationWebhookRecord` gains a required `alertEvents` field, and the
`notification_webhooks` table gains an `alert_events` column on both runtimes. Existing rows
default to `[]`, so every registered endpoint keeps its current behaviour byte-for-byte.
