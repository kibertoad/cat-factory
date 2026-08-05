---
'@cat-factory/kernel': minor
'@cat-factory/contracts': minor
'@cat-factory/integrations': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/app': minor
'@cat-factory/conformance': minor
---

OAuth for external MCP tool servers, so the OAuth-first hosted ecosystem (Linear, Atlassian,
Figma, Slack's remote server) is reachable at all. A remote (`http`) declaration may now carry
`oauth`: the `authorization_code` grant, which a `secrets.manage` holder completes once per board
from the Infrastructure window, and `client_credentials`, which needs no human and covers an
internal or partner server. Endpoints are discovered per the MCP authorization spec (RFC 9728 →
RFC 8414 → OIDC discovery) with a declaration override, PKCE and the RFC 8707 `resource` indicator
are always used, and the grant is sealed per (workspace, server) and refreshed on the dispatch
path. The access token rides the job body's header channel only, never a prompt or the telemetry
snapshot.

Two new unavailability reasons (`oauth_not_connected`, `oauth_token_failed`) and the matching probe
verdicts keep "nobody connected", "the connection stopped working" and "no credential configured"
apart, since each sends an operator somewhere different. New table `mcp_oauth_grants` on both
runtimes (D1 migration 0082 ⇄ a Drizzle migration), in the mothership `remote` bucket. Interactive
grants need `MCP_OAUTH_REDIRECT_URL` set to the deployment's public `/mcp/oauth/callback` URL and
`ENCRYPTION_KEY` for the sealed store; without either, an OAuth server is stated to its agent as
unavailable rather than dispatched without a token.
