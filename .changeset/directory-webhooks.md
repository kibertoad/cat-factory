---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/integrations': minor
'@cat-factory/workspaces': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/sdk': minor
'@cat-factory/mcp-server': minor
'@cat-factory/gatekeeper-bindings': patch
---

Directory webhooks: `/api/v1/directory/webhooks` registers account-level endpoints that the
directory change feed is pushed to every couple of minutes, signed like the notification webhooks.
Each push is a `directory.changed` page of hydrated changes, or `directory.resync_required` for an
endpoint that fell behind the feed's retention. Delivery is a sweep on both facades (the Worker's
frequent cron, a Node timer) that takes a per-endpoint lease before a push and moves the endpoint's
position only after the push succeeds, so pushes are at-least-once, arrive in feed order, and are
never doubled by concurrent sweepers; a lease whose sweeper died expires and the page is sent again. The spec gains an OpenAPI 3.1 `webhooks` section naming every push body, so
`DirectoryWebhookDelivery`, `NotificationWebhookDelivery`, `RunWebhookDelivery` and
`PlatformAlertWebhookDelivery` become generated types in every client.
OpenAPI 1.81.0. New migrations: D1 `0109_directory_webhooks.sql`, Drizzle
`20261010113115_directory_webhooks`.
