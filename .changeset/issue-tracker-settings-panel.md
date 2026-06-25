---
'@cat-factory/app': minor
---

Add a first-class **Issue tracker** settings panel (Workspace settings → Issue tracker,
also linked from the Integrations hub) that gathers everything about issue tracking in one
discoverable place:

- **Filing tracker** — select where the tech-debt recurring pipeline files its ticket
  (GitHub Issues / Jira / none), with inline readiness hints. Previously this selection was
  only reachable buried inside the tech-debt recurring-pipeline modal, so a workspace had no
  obvious way to designate GitHub Issues as its tracker.
- **Linking sources** — the per-workspace on/off toggle for each task source (GitHub Issues
  rides the installed GitHub App; Jira via a connection), with a Connect/Install shortcut
  when a source isn't usable yet. This makes explicit that filing and linking are independent
  (so "I have the GitHub App but nothing is surfaced" no longer reads as a dead end).
- **Writeback** — the comment-on-PR-open / close-on-merge toggles, folded in from the old
  standalone "Issue writeback" tab.

Frontend-only: it reuses the existing `tracker-settings` and `task-sources` endpoints, so the
behaviour is identical across the Cloudflare, Node, and local runtimes. The standalone
`IssueTrackerWritebackPanel` is removed (its content moved into the new panel).
