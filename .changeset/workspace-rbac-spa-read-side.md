---
'@cat-factory/app': minor
---

Workspace RBAC (slice 8): SPA read-side degradation for viewers/members.

The auth gate already attaches the caller's resolved `{ role, permissions }` to the workspace
snapshot; this slice consumes it in the SPA so a read-only viewer (or a member) sees the board
but not affordances they can't use — mirroring the backend enforcement, never replacing it
(the backend still authorises every write).

- **`useWorkspaceAccess()` composable** — the central helper for gating _workspace-scoped_
  affordances: `role`, `can(permission)`, and the per-permission computeds (`canWriteBoard`,
  `canExecuteRuns`, `canManageSettings`, `canManageIntegrations`, `canManageSecrets`,
  `canManageMembers`) plus `isViewer`/`isMember`/`isAdmin`. Absent access (auth disabled /
  dev-open) ⇒ `can()` is `true` for everything, matching the backend's allow-all branch.
- **Store hydration** — the workspace store hydrates `access` from the snapshot and keeps the
  board-list rows' `viewerRole` annotation so a restricted board can be badged in the switcher.
- **Board-editing degradation (`board.write`)** — drag/reparent, frame resize, and block
  delete/archive no-op for viewers at their shared composables (covering the keyboard shortcut
  too); the create affordances are hidden (SideBar + command bar create/repo entries, the board
  empty-state buttons, the service-frame add-task/from-issue/recurring/initiative buttons, and the
  toolbar mount/restore menus). Inspector delete/archive are disabled with a tooltip.
- **Run/HITL degradation (`runs.execute`)** — the inspector Run trigger, stop/reset, agent-run
  retry, agent stop, spend resume, notification act/dismiss, recurring-pipeline scheduling, and
  the HITL decision windows' action buttons are disabled for viewers (windows stay visible
  read-only), each with a "read-only access" tooltip.
- **Settings nav gating** — SideBar + command-bar entries for workspace/model settings and the
  fragment library (`settings.manage`), integration/infrastructure/sandbox/bootstrap
  (`integrations.manage`), and board rename/delete (`settings.manage`) are shown only to callers
  who hold the matching permission.
- **i18n** — new `access.*` copy (read-only tooltips + the viewer badge) in `en` and all locales.
