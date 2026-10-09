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
frequent cron, a Node timer) that claims each endpoint's position by compare-and-swap before a push
and releases it after a failed one, so pushes are at-least-once and never doubled by concurrent
sweepers. The spec gains an OpenAPI 3.1 `webhooks` section naming `DirectoryWebhookDelivery`.
OpenAPI 1.81.0. New migrations: D1 `0109_directory_webhooks.sql`, Drizzle
`20261009151938_directory_webhooks`.
