---
'@cat-factory/app': minor
---

Add a UI for managing API access tokens. A new "API access tokens" panel (reached from the
Integrations hub, under Development) lists a workspace's inbound public-API keys and lets a
member mint a new one, copy the raw secret exactly once at creation, and revoke keys. Backed
by the existing public-API-key management endpoints under `/workspaces/:workspaceId/public-api-keys`.
