---
'@cat-factory/kernel': minor
'@cat-factory/contracts': minor
'@cat-factory/integrations': minor
'@cat-factory/server': minor
'@cat-factory/app': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
---

Add a "Create task from issue" button on service frames, and scope issue search to
the service's repo.

A service frame header now carries a ticket button (shown when a tracker is offered)
that opens the tracker-issue modal pinned to that service: the new task is created in
that frame, and the issue search is scoped to the service's linked GitHub repository
instead of the whole installation. The same repo scoping applies to the
attach-an-issue-as-context picker in the add-task form.

Within a scoped GitHub search:

- a pasted issue URL (or `owner/repo#n` / `owner/repo/issues/n`) resolves to that exact
  issue and is offered first instead of being fuzzy-matched — but only within the
  searching workspace's own GitHub App installation, so a URL naming another account is
  never fetched across tenants;
- a bare issue number (`11`) resolves against the service's repo and is offered first;
- free-text hits are restricted to the service's repo (`repo:owner/name`).

A service is always created from (or with) a repo, so a GitHub search scoped to a block
now REQUIRES that link: if the service isn't linked to a repo the search is refused with
a clear error rather than silently widening to the whole installation. The
block→service→repo resolver (`resolveRepoTarget`) is surfaced on the request container in
both runtime facades so the shared task-search controller can resolve the scope.
