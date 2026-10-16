---
'@cat-factory/contracts': minor
'@cat-factory/server': minor
'@cat-factory/sdk': minor
'@cat-factory/directory-sync': patch
'@cat-factory/mcp-server': patch
'@cat-factory/gatekeeper-bindings': patch
---

`GET /api/v1/directory/reach` (`client.directory.getReach`) answers the calling key's account and
workspace reach without an `x-cat-factory-workspace` header. `GET /api/v1/me` names one workspace,
so it refused a key reaching several that sent no header, and that is every key a directory webhook
accepts.

`DirectorySyncer.handleDelivery` read the key's reach from `/me`, so every push to a directory
webhook failed with `422 workspace_required`. It now reads `/api/v1/directory/reach`, and falls back
to `/me` against a deployment without that route or with an SDK that predates `getReach`. OpenAPI
1.86.0.
