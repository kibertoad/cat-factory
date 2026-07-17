---
'@cat-factory/contracts': minor
'@cat-factory/workspaces': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
---

Workspace RBAC (slice 5): the member-management API.

Adds the workspace-membership roster + access-mode management surface that lets an account
admin restrict a board to an explicit member list. New `WorkspaceMemberService`
(`@cat-factory/workspaces`) owns `list` / `add` / `setRole` / `remove` + `setAccessMode`,
built in `createCore` whenever the workspace-member repository is wired (both facades wire it;
absent ⇒ the controller reports 503). The one rule beyond wire validation is that a member must
already belong to the board's owning account — a `restricted` board narrows WITHIN an account,
never grants across it — so scoping an outsider is a `ValidationError` (422); a legacy
(`account_id IS NULL`) board refuses member management.

New routes under `/workspaces/:ws` (`@cat-factory/contracts` + `@cat-factory/server`):
`GET/POST/PATCH/DELETE /members` and `PUT /access-mode`. The roster GET is open to any resolved
role (`workspace.read`, satisfied by the gate resolution itself); every write requires
`members.manage`, enforced by the new `requirePermission(c, permission)` helper
(`http/workspaceAccess.ts`) — it consumes the access the gate published (never re-derives
membership), allows the dev-open path, and throws `ForbiddenError` (403) on insufficiency.

Every roster/access-mode write invalidates the board's `workspaceAccess` cache group right after
it commits (the group-invalidation slice 4 deferred to the member service), so a live grant,
role change, or access-mode flip is visible on the immediately-following request rather than
riding the TTL. Cross-runtime conformance asserts the full lifecycle over HTTP — restrict → add
viewer → promote to member → remove — with live cache coherence on each step, plus the
`members.manage` 403s and the only-account-members 422, identically on D1 and Postgres.
