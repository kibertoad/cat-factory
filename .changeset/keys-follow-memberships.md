---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/integrations': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/conformance': minor
'@cat-factory/app': minor
'@cat-factory/sdk': minor
'@cat-factory/gatekeeper-bindings': minor
'@cat-factory/mcp-server': minor
---

A personal API key can follow its person's workspaces. Minted with `followsMemberships: true`
(beside `actsAsSelf: true`, and no `workspaceIds`), it reaches every workspace that person can act
in, resolved on each call: joining a workspace grants it on the next call and leaving takes it
away, with nothing to re-mint. In each workspace its scope is lowered to what the person's role
there allows (`read` for a viewer, `decide` for a member, `admin` for an admin), and on account-level
routes it acts with `read`, so it can never do more over `/api/v1` than its person can in the app.
That is also why anyone with `runs.execute` may mint one, list it and revoke it; an account admin
manages anyone's.

`followsMemberships` is new on a listed or minted key (whose `workspaceIds` is then `[]`), on
`GET /api/v1/me` and on `GET /api/v1/directory/reach`, which answer the reach as of the call.
OpenAPI 1.89.0. The API tokens window offers "My workspaces (follows my memberships)", the default
for a personal token, and `?newApiKey` takes `reach=memberships`. New migrations: D1
`0110_public_api_key_follows_memberships.sql`, Drizzle
`20261016160143_public_api_key_follows_memberships`.
