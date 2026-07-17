---
'@cat-factory/kernel': minor
'@cat-factory/caching': minor
'@cat-factory/workspaces': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': patch
---

Workspace RBAC (slice 4): cache the effective-access resolution behind the app cache seam.

The shared auth gate resolves a caller's effective workspace access on every
`/workspaces/:ws/*` request (three reads: the board access row, the caller's account roles,
their member row). This adds a `workspaceAccess` slice to the kernel `AppCaches` port
(`@cat-factory/caching`) so `loadWorkspaceAccess` reads through it — grouped by workspace id,
keyed by user id, with both a denial and a missing board cached as values (negative caching).
A cache hit costs zero repository reads.

Coherence is invalidation-driven, after each write commits: a board delete drops the
workspace group (`WorkspaceService.delete`), and account-tier membership writes
(`AccountService.addMember` / `setMemberRoles`, `InvitationService.accept`) drop everything
(`invalidateAll` — the deliberate coarse fallback for a rare management action, since a new
membership can change access to many boards). The roster + access-mode write paths added by
the member-management API (a later slice) invalidate the same workspace group on their own
writes.

The slice follows the established seam rules: the `DEFAULT_APP_CACHES_PROFILE` enables it with
a short 60s TTL (a freshness backstop; invalidation is the real coherence story), while the
Worker's `ISOLATE_SAFE_APP_CACHES_PROFILE` keeps it **pass-through** — the resolution reads our
own mutable D1 state and a Worker isolate has no cross-isolate invalidation bus, so a TTL'd
entry could keep granting access after a peer isolate revoked a member. Cross-runtime
conformance asserts an account-membership grant is visible on the immediately following request
(the cached denial is dropped) on both D1 and Postgres.
