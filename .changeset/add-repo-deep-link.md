---
'@cat-factory/contracts': minor
'@cat-factory/server': minor
'@cat-factory/app': minor
'@cat-factory/sdk': minor
'@cat-factory/mcp-server': minor
'@cat-factory/gatekeeper-bindings': minor
---

An integration can now send a person to add a service for a repository. `GET /api/v1/deployment`
(`client.deployment.get`) answers where the deployment serves its web app, to any `read` key with
no workspace named. The app opens the add-service window with the repository searched for and
selected from `?addRepo=<owner>/<name>`, with optional `provider` and `ws` to name the host and
pin the board. Signing in first keeps the link.
