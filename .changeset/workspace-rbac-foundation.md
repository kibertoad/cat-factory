---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/server': patch
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
---

feat(rbac): workspace-RBAC vocabulary + membership persistence (initiative slices 1–2)

Lay the foundation for workspace-level access control below the account tier — no enforcement
yet (that is a later slice), just the shared vocabulary and the persistence both facades need.

- **Contracts**: `workspaceRoleSchema` (`admin | member | viewer`), `workspacePermissionSchema`
  (the seven-permission capability catalog), `workspaceAccessModeSchema` (`account | restricted`),
  and the `WorkspaceMember` wire shape; `workspaceSchema` gains an optional `accessMode`.
- **Kernel**: `domain/workspace-access.ts` — the static `WORKSPACE_ROLE_PERMISSIONS` map plus the
  pure `resolveWorkspaceAccess` / `workspaceRoleAtLeast` / `permissionsForRole` helpers (with a
  decision-table test); a new `ForbiddenError` (`DomainErrorCode 'forbidden'`, mapped to 403); and
  the `WorkspaceMemberRepository` port (batch-shaped: `getRolesForUserInWorkspaces`,
  `removeByAccountMembership`) plus `WorkspaceRepository.accessRowOf` / `setAccessMode`.
- **Persistence (both runtimes)**: a new `workspace_members` table + a `workspaces.access_mode`
  column (D1 migration `0052_workspace_rbac.sql` ⇄ Drizzle), the D1 and Drizzle repository impls,
  and a cross-runtime conformance suite asserting the roster CRUD, the batched role annotation, the
  account-membership cascade, and the access-mode round-trip on both stores. The default access
  mode is `account`, so every existing board is unchanged (no data migration).
