---
'@cat-factory/contracts': minor
'@cat-factory/server': patch
'@cat-factory/app': minor
---

feat: repo-sourced Claude Skills — frontend (slice 3)

Surface the account's repo-sourced Claude Skills in the SPA
(docs/initiatives/repo-skills.md):

- **Snapshot skills list.** The workspace snapshot now carries the account's skill
  catalog as lightweight `{ id, name, description }` summaries (one cached account read,
  shared across the account's workspaces), attached by the shared `WorkspaceController`
  and hydrated into a `skills` store. Best-effort — an unwired library or read failure
  degrades to no options rather than breaking the board load.
- **Per-step skill picker.** The generic `skill` palette block (already surfaced via
  `customAgentKinds`) gets a per-step picker in the pipeline builder bound to
  `stepOptions[i].skillId`, with inline hints when no skills exist, a step has no skill
  selected (mirroring the backend save/start rejection), or a picked skill has left the
  catalog (renamed/unlinked source).
- **Account Skills management UI.** A new "Skills" tab in Account settings lists the
  synced catalog and manages linked repo sources (link via the GitHub repo/dir picker or
  manual entry, check-for-changes, resync, unlink), mirroring the fragment library's
  repo-sources surface. The GitHub-integration and library opt-in gates degrade the UI
  cleanly (503 → hidden/notice) rather than erroring.
- Full i18n in all locales (en/de/es/fr/he/it/ja/pl/tr/uk).
