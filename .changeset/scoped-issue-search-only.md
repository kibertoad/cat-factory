---
'@cat-factory/integrations': minor
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/server': minor
'@cat-factory/app': minor
---

Confine every GitHub issue search to one repository, and refuse an unscoped one.

`/search/issues` carries no scope of its own: a query with no `repo:` qualifier returns whatever
the credential can reach. Under a GitHub App installation token that is the installation's own
repos, so an unscoped query looked harmless — but under a PAT (local mode, and any per-workspace
PAT connection) the same query searches every public repository on GitHub, and the issue picker
offered strangers' issues as if they were the service's own. The repo scope is now required by
construction rather than supplied by each caller: `buildGitHubIssueSearchQuery` takes a mandatory
scope, `GitHubIssuesProvider.search` refuses a call without one, and the search endpoint's
`blockId` is a required field. `buildGitHubIntakeQuery` gets the same treatment — a `bug-intake`
schedule with no repository configured now fails its fire loudly instead of scanning all of public
GitHub and importing whatever it found.

The kernel port carries that requirement: `TaskSourceProvider.search`'s `scope` is now a REQUIRED
parameter with a NULLABLE value (`TaskSearchRepoScope | null`). A repo-less source (Jira, Linear)
states its `null`; a caller can no longer reach an unscoped search by omitting the argument, which
is a typecheck failure. Repo-less provider implementations are unchanged — they declare fewer
parameters.

A reference naming ANOTHER repository is no longer resolved into the results either, so search
results are exactly the service's own issues. Linking such an issue still works: paste its URL and
the picker's "attach by reference" row imports it directly, which never rode the search path. A
reference that DOES name the scoped repo is now normalised to the scope's casing before it becomes
an external id: GitHub lookup is case-insensitive but an external id is stored verbatim, so
`Owner/Repo#1` and `owner/repo#1` used to import as two projection rows for one issue.

The `reason` codes these refusals carry are declared in `@cat-factory/contracts`
(`TASK_SOURCE_READ_REASONS`) and imported by both the emit sites and the SPA, so renaming one
fails the typecheck instead of silently degrading the SPA to the backend's untranslated prose.
`boards_unsupported`, which the bug hunt already relied on as a bare literal on both sides, joins
the same union.

Wire break (pre-1.0, no migration): `POST /workspaces/:ws/task-sources/:source/search` now requires
`blockId`, and a search from a service frame with no linked repository is refused with
`reason: 'repo_not_linked'` rather than silently widened.
