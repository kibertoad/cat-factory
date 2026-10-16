---
'@cat-factory/contracts': minor
'@cat-factory/server': minor
'@cat-factory/integrations': patch
'@cat-factory/kernel': patch
'@cat-factory/app': minor
'@cat-factory/sdk': minor
'@cat-factory/mcp-server': patch
'@cat-factory/gatekeeper-bindings': minor
'@cat-factory/gatekeeper-worker': patch
---

API keys gain a `webhooks` scope between `read` and `write`: everything `read` can do, plus
registering and removing push endpoints. The directory webhooks (`/api/v1/directory/webhooks`,
still for a key reaching every workspace) and the notification webhooks
(`/api/v1/notification-webhook[s]`) now need `webhooks` instead of `admin`, so a sync integration
can follow changes with a key that cannot author or delete work. Every key that could manage
webhooks before still can. OpenAPI 1.86.0.

The API token form names each scope by its API name (`read`, `webhooks`, `write`, `decide`,
`admin`), so the screen, the docs and the refusal messages agree. "Full access" is now "Admin".

The token form always shows the Workspaces picker, in basic and advanced mode. It is disabled for
anyone who is not an account admin, with a line saying so, because only an account admin may mint
a key that reaches other workspaces.
