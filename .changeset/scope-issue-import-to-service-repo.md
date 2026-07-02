---
'@cat-factory/contracts': patch
'@cat-factory/integrations': patch
'@cat-factory/server': patch
'@cat-factory/app': patch
---

Scope the "create task from a GitHub issue" picker's already-imported list to the
target service's repo. The quick-pick list of imported issues was filtered only by
source and free text, so it leaked in issues from every repo in the workspace even
though the live search was already repo-scoped. `listTasks` now accepts an optional
`blockId` that resolves the service's linked repo (via the same `resolveRepoTarget`
the search uses) and drops GitHub issues from other repos; repo-less sources (Jira,
Linear) are unaffected. The picker fetches its own repo-scoped list rather than
reading the shared workspace-wide store.
