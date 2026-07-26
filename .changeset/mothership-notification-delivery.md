---
'@cat-factory/server': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/worker': minor
---

Mothership mode: delegate notification DELIVERY to the mothership.

A mothership-mode local node persists its notification rows on the mothership but holds none of
the org's external delivery credentials (the Slack bot token is sealed with the mothership's
encryption key, which never reaches a laptop), so a `merge_review` / `ci_failed` /
`release_regression` raised by a local run landed in the inbox and never reached the team's Slack.

Adds the machine-authed `POST /internal/notifications/deliver`, mounted on BOTH facades behind the
same audience pin + account scoping as the persistence RPC. The wire carries identifiers only
(`{ workspaceId, notificationId }`) — the mothership re-reads the row from its own workspace-scoped
store and delivers THAT, so a node can never inject forged notification text into the org's Slack.
Each facade wires the new `ServerContainer.machineNotificationDelivery` seam with its EXTERNAL
channels only; the in-app frame for a laptop-raised notification already arrives over the real-time
upstream relay, so it is never double-pushed. A deployment with no external channel serves a 503.

On the consumer side, `composeMothership` builds a `RemoteNotificationChannel` (same base URL +
per-request machine token as the persistence RPC; a token-less node skips the round-trip) and
`buildLocalContainer` threads it into `buildNodeContainer`'s new `notificationChannels` option, so
it composes alongside the local in-app push with no engine change. Delivery stays best-effort: an
unreachable mothership is logged, never propagated into the state transition that raised the row.
