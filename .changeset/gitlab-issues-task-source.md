---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/gitlab': minor
'@cat-factory/integrations': minor
'@cat-factory/server': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/worker': minor
'@cat-factory/app': minor
---

Add GitLab Issues as a task source: import, search and setup check.

`gitlab` joins `BUILTIN_TASK_SOURCE_KINDS`, so a shop that runs GitLab for both code and issues can
link an issue onto a board block as agent context instead of connecting a second vendor beside its
repositories. `GitLabIssuesProvider` stores no credentials of its own: it reads through the
workspace's existing GitLab connection, the same credentialless shape GitHub Issues has. The
recurring `bug-intake` schedule, the bug hunt, push intake and ticket writeback are the remaining
slices ([`docs/initiatives/gitlab-issues-intake.md`](./docs/initiatives/gitlab-issues-intake.md)).

The public-API `TaskSourceKind` enum gains a member (OpenAPI 1.24.0, SDKs regenerated). Additive on
a closed vocabulary the clients already tolerate unknown members of, so a consumer built against
1.23.0 keeps parsing every response it understood.

Four internal shapes changed, none externally consumed:

- `VcsClient` / `GitHubClient` gain an optional `searchProjectIssues(connection, ref, query)`.
  GitLab's global issue search accepts no project qualifier, so a repo scope cannot be expressed as
  query text there the way GitHub's `repo:` does; the scope is an argument instead, and the
  predicates ride a `ProjectIssueQuery` the vendor evaluates.
- `TaskSourceProvider.fetchTask` takes `workspaceId`. A GitLab PAT connection is keyed on the
  workspace, not on the account owning the project, so without it the provider could only scan
  every connection on the deployment for one able to read the id.
- `TaskSourceProvider` gains an optional `repoScope`, whose PRESENCE declares the source
  repo-backed. One member rather than a flag beside a matcher, because the same fact decides two
  things that must agree: that the source's search is handed a resolved repository, and that the
  workspace's imported rows narrow to one.
- `TaskSourceState` gains `supportsIntake` and `ridesVcsProvider`, both derived from the registered
  provider: whether it implements the predicate search a schedule fires, and which VCS connection
  it authenticates through (so the settings panel can name the right remedy for an unavailable
  source instead of inferring one).

Two live bugs are fixed on the way. A workspace connected to GitLab reported **GitHub Issues** as
available (availability keyed on a connection EXISTING rather than on its provider, and both live in
one row per workspace), so the source looked connected and its import resolved an empty projection.
And the recurring-schedule form offered every connected source regardless of whether its provider
could search on a schedule, which saved a schedule that could never fire.

Three surfaces that hard-coded `github` are now asked of the registry, which is what makes a
FOURTH source work rather than merely exist: the search route resolves a repo scope for any source
declaring `repoScope` (a repo-backed source refuses a null one, so GitLab search was 422ing on
every query), the imported-issue list narrows every repo-backed source's rows to the service's own
repository, and the issue-tracker settings panel renders one card per registered source instead of
one hard-coded card per built-in.
