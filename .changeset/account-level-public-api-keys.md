---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/integrations': minor
'@cat-factory/server': minor
'@cat-factory/workspaces': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/app': minor
'@cat-factory/sdk': minor
'@cat-factory/mcp-server': patch
'@cat-factory/gatekeeper-bindings': patch
---

Public-API keys belong to an account and reach every workspace in it or a chosen list. A
workspace-scoped `/api/v1` call names its workspace in the `x-cat-factory-workspace` header, which a
key reaching one workspace may omit, so every existing key keeps working unchanged. `PublicApiKey`
and `GET /api/v1/me` gain `workspaceIds`; both mint bodies accept it. Widening a key past the board
it is minted from takes an account admin, and a key can never mint or revoke one reaching further
than itself. The header is on the CORS allow-list, so a browser client can send it. The four SDK
clients take a workspace option. OpenAPI 1.80.0.

Storage break (internal): `public_api_keys.workspace_id` is replaced by `all_workspaces` plus the
`public_api_key_workspaces` grant table (D1 `0108`, Drizzle `20261009143721` and `20261009143724`),
backfilled from the old column. The account cap is 200 live keys, where it was 50 per workspace,
and a key left with no workspace after its boards were deleted holds no slot.
