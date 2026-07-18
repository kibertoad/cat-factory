---
'@cat-factory/app': minor
---

Workspace RBAC (slice 9): SPA membership-management UI.

The member-management API (slice 5) and the read-side access composable (slice 8) already
exist; this slice adds the admin surface that drives them — a "Members" tab in workspace
settings, shown only to a caller who holds `members.manage`.

- **`WorkspaceMembersSettings.vue`** — the board's access-mode toggle (restrict to an explicit
  roster vs. every account member), the roster with per-member role selects (admin/member/viewer)
  and remove, and an add-member picker sourced from the OWNING account's roster (a contractor
  joins the account first, then gets scoped to the board). The signed-in caller is badged as
  "you"; a legacy board with no linked account shows no picker until its first write auto-heals
  it.
- **`useWorkspaceMembersStore`** — the board roster + access-mode flip over the slice-5 routes;
  the access-mode flip patches the board-list row in place so the switcher badge updates without a
  re-fetch.
- **Members tab** — mounted in `WorkspaceSettingsPanel`, gated by `useWorkspaceAccess().canManageMembers`.
- **Switcher badge** — a restricted board carries a lock glyph in the board switcher (alongside
  the existing viewer badge) so an admin can see at a glance which boards are scoped.
- **i18n** — new `layout.workspaceMembers.*` + `settings.workspaceSettings.tabs.members` copy in
  `en` and real translations in all locales (de/es/fr/he/it/ja/pl/tr/uk).
