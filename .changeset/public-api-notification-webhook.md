---
'@cat-factory/contracts': minor
'@cat-factory/server': minor
'@cat-factory/conformance': minor
'@cat-factory/sdk': minor
'@cat-factory/mcp-server': minor
---

Manage the outbound notification webhook over `/api/v1`, so the whole integration surface is
headless.

`GET|PUT|DELETE /api/v1/notification-webhook` (`admin` scope) register, read and remove the one
HTTPS endpoint a workspace pushes its notifications, run-lifecycle events and platform-health
alerts to. Until now that endpoint could only be registered over the session-authed
`/workspaces/:ws/notification-webhook`, so a deployment driven entirely by API keys had to put a
human in a browser to switch on the very channel that exists because there is no browser: the
delivery contract was headless and its enrolment was not.

The routes delegate to the same `NotificationWebhookService` the session controller calls, so the
SSRF guard on the endpoint, the keep-on-omit rule for every field and the one-row-per-workspace
invariant are identical whichever surface writes. The signing secret stays write-only: `PUT`
accepts one and the read reports only `hasSecret`, so an `admin` key can rotate it and can never
learn the stored one. The session-authed routes are unchanged.

Additive on `/api/v1` (OpenAPI `info.version` 1.4.0). The four SDK clients gain a `webhook`
resource (`get` / `set` / `delete`) and the MCP facade the matching `webhook_*` tools.
