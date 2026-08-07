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

The public-API `TaskSourceKind` enum gains a member (OpenAPI 1.22.0, SDKs regenerated). Additive on
a closed vocabulary the clients already tolerate unknown members of, so a consumer built against
1.21.0 keeps parsing every response it understood.

Three internal shapes changed, none externally consumed:

- `VcsClient` / `GitHubClient` gain an optional `searchProjectIssues(connection, ref, query)`.
  GitLab's global issue search accepts no project qualifier, so a repo scope cannot be expressed as
  query text there the way GitHub's `repo:` does; the scope is an argument instead, and the
  predicates ride a `ProjectIssueQuery` the vendor evaluates.
- `TaskSourceProvider.fetchTask` takes `workspaceId`. A GitLab PAT connection is keyed on the
  workspace, not on the account owning the project, so without it the provider could only scan
  every connection on the deployment for one able to read the id.
- `TaskSourceState` gains `supportsIntake`, derived from whether the registered provider implements
  the predicate search a schedule fires.

Two live bugs are fixed on the way. A workspace connected to GitLab reported **GitHub Issues** as
available (availability keyed on a connection EXISTING rather than on its provider, and both live in
one row per workspace), so the source looked connected and its import resolved an empty projection.
And the recurring-schedule form offered every connected source regardless of whether its provider
could search on a schedule, which saved a schedule that could never fire.
