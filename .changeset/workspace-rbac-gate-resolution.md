---
'@cat-factory/kernel': minor
'@cat-factory/contracts': minor
'@cat-factory/workspaces': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
---

Workspace RBAC (slice 3): resolve effective workspace access in the shared auth gate.

`mountAuthGate` now resolves a signed-in caller's effective workspace role once (via the
new `loadWorkspaceAccess` helper over the kernel `resolveWorkspaceAccess` decision) and
publishes it on the request context as `workspaceAccess`. A denied board returns the
existing 404 shape (existence is never leaked); a resolved-but-insufficient write hits the
**viewer write floor** — any non-GET method requires at least `member`, with the read-only
`POST /workspaces/:ws/events/ticket` mint allowlisted — returning `403 forbidden`. The
account-admin escape hatch and the legacy owner-only board are preserved byte-for-byte.

`WorkspaceVisibility` is extended (unrestricted account boards, an admin-account escape
hatch, an explicit-membership branch, and legacy-owned boards) and enforced SQL-side in
both the D1 and Drizzle `listVisible`; `AccountService.accessibleAccountScopes` derives the
member/admin account sets from the single existing membership read. `GET /workspaces`
annotates each board with the caller's effective `viewerRole` via one batched member-row
read, and the board snapshot (GET + create) carries the resolved `access` (role +
permissions). `WorkspaceService.create` auto-enrolls the creator as a workspace admin. The
`workspace_members` repository is now wired into both runtime facades' containers. Cross-
runtime conformance asserts the 404 invisibility, the viewer floor + ticket allowlist, the
escape hatch, and list filtering over the real HTTP gate on both D1 and Postgres.
