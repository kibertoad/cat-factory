---
'@cat-factory/app': minor
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/integrations': minor
'@cat-factory/server': minor
---

Add a first-class **Issue tracker** settings panel (Workspace settings → Issue tracker,
also linked from the Integrations hub) plus a **live "Check setup" diagnostic** so a
workspace can both configure issue tracking in one place and see *why* a source isn't
working.

**Panel (frontend).** One discoverable home that gathers what used to be scattered:

- **Filing tracker** — select where the tech-debt recurring pipeline files its ticket
  (GitHub Issues / Jira / none). Previously only reachable buried inside the tech-debt
  recurring-pipeline modal, so a workspace had no obvious way to designate GitHub Issues.
- **Linking sources** — the per-workspace on/off toggle for each task source, making
  explicit that filing and linking are independent.
- **Writeback** — the comment-on-PR-open / close-on-merge toggles, folded in from the old
  standalone "Issue writeback" tab (`IssueTrackerWritebackPanel` is removed).

**Live "Check setup" (backend, all runtimes).** A new
`POST /workspaces/:ws/task-sources/:source/diagnostics` endpoint actually authenticates
against the source and reads a slice of its issues API, returning a classified verdict —
`ready` / `not_installed` / `not_connected` / `auth_failed` / `forbidden` / `unreachable` /
`error` — with an actionable message. For GitHub Issues it escalates three probes
(validate the App credentials → mint the installation token + list repos → read issues on a
repo) so a 403 pinpoints the most common misconfiguration: the GitHub App lacks the
**Issues** permission. For Jira it probes `/myself` and distinguishes a rejected token (401)
from a forbidden account (403). The panel also now surfaces the previously-swallowed probe
error (e.g. "503 — integration disabled / ENCRYPTION_KEY not set", "500 — backend not
migrated") instead of a blanket "install integration first".

Adds an optional `diagnose` capability to the `TaskSourceProvider` port (kernel), implemented
by the GitHub and Jira providers and orchestrated by `TaskConnectionService.diagnose`
(integrations), the `taskSourceDiagnosticSchema` wire contract (contracts), and the
controller endpoint (server). Runtime-neutral — wired through the existing `tasks` module on
Cloudflare, Node, and local — with a cross-runtime conformance assertion (gate-on-connection
then delegate-to-provider). A provider without `diagnose` falls back to a static verdict
from availability.
