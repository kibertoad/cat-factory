---
'@cat-factory/server': minor
'@cat-factory/app': minor
'@cat-factory/contracts': patch
'@cat-factory/kernel': patch
'@cat-factory/integrations': patch
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
---

Workspace RBAC (slice 7): close the enforcement side doors.

- **`/me/environment-handlers/:workspaceId`** — this per-user infra-override surface is mounted
  at `/` and previously bypassed the workspace gate entirely (any signed-in user could address any
  workspace id). It now resolves access through the SAME shared `loadWorkspaceAccess` the gate uses
  and requires `runs.execute`: a caller with no access at all gets a 404 (existence stays hidden,
  exactly as the gate hides a board), while a caller who sees the board but lacks the capability
  gets a 403. Authorization runs before the local-only service-availability 503, so the verdict is
  identical on every facade regardless of whether the handler service is wired.
- **WS event-stream ticket gains `userId`** — the ticket minted at `POST …/events/ticket` now
  carries the minting user for audit. Verification stays membership-blind (the claim is never
  consulted on upgrade); it is provenance only, absent in dev-open.
- **`public_api_keys.created_by_user_id`** (both runtimes: D1 migration `0054` ⇄ Drizzle column) —
  a minted public-API key records the acting user for audit + UI attribution, surfaced on the wire
  (`PublicApiKey.createdByUserId`) and in the API-tokens panel ("created by …"). Minting is already
  gated under `secrets.manage` (slice 6). A key is a workspace-scoped SERVICE credential that
  intentionally outlives its minter's access — the column is never an authorization input (no FK),
  so revocation stays an explicit admin action.

The cross-runtime RBAC conformance suite gains assertions for the side-door 404/403 and the
`created_by_user_id` round-trip on both stores.
