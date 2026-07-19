---
'@cat-factory/kernel': minor
'@cat-factory/integrations': minor
'@cat-factory/app': patch
---

Make GitHub available as a document source automatically once the GitHub App (or PAT) is
installed, and let a task be authored with no source connected yet without losing entered
data.

- **GitHub docs are now implicitly connected.** A new optional
  `DocumentSourceProvider.resolveImplicitConnection(workspaceId)` port method lets a source
  that rides an out-of-band credential report itself connected without a stored marker row.
  `GitHubDocsProvider` implements it against the workspace's installed App (present ⇒
  connected), and `DocumentConnectionService.listConnections` / `getConnection` /
  `requireConnection` honour it (a stored credentialed connection still wins and is never
  duplicated). This mirrors how the GitHub-issues task source is already available the moment
  the App is installed, so GitHub docs no longer need a separate "connect" step and can be
  searched / imported / linked as task context right away.

- **Document reads are now tenant-scoped.** `DocumentSourceProvider.fetchDocument` /
  `probeVersion` take the `workspaceId` (like `search` already did), and `GitHubDocsProvider`
  resolves the installation to read with via `getByWorkspace` — requiring the doc's owner to
  match the workspace's own installation account — instead of a deployment-wide scan by owner.
  A crafted `owner/repo:path` external id can therefore no longer reach another tenant's repo
  through a different workspace's installation token.

- **Connect a source inline from the new-task form.** In the add-task modal the "Context
  documents" / "Context issues" sections previously showed a disabled Attach button when no
  source was connected. They now offer a "Connect a source" action that opens the source's
  connect modal over the task form — both are root-mounted with independent open flags — so
  the user's in-progress title/description/context is preserved instead of being lost to a
  navigation away.
