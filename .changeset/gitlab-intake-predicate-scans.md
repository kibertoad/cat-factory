---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/integrations': minor
'@cat-factory/gitlab': minor
'@cat-factory/app': minor
---

Let a GitLab-only deployment run the recurring bug-intake schedule and the interactive bug hunt.

The GitLab task source could import an issue you pointed at and search the project a service frame
was linked to, but neither of the two paths that PICK work by predicate: the recurring `bug-intake`
schedule and the bug hunt. So a shop running GitLab for both code and issues could have its agents
work in its repositories and still had to connect a second tracker to schedule anything.

`GitLabIssuesProvider` now implements `searchIssues`, `listBoards` and `listBugCandidates`, all
three riding the project-scoped issue read the earlier slice added: the scope is an ARGUMENT of the
request rather than a qualifier in a query string, and GitLab returns the description, labels, age
and note count in the same response, so a whole hunt scan is one call per page and never a
per-candidate fetch. A schedule scopes itself with a new `gitlabProject` board field (its own leg,
because a GitLab namespace nests and `owner/name` cannot express it) which the recurring-pipeline
modal now renders.

Two provider differences are stated rather than smoothed over. GitLab's issue search covers the
description as well as the title, so a title-fragment predicate now rides a new `textIn: 'title'`
narrowing: without it a schedule configured on a fragment would have started a pipeline on an issue
that merely mentions it in its body. And `issueType` is ignored, as it already is on Linear:
GitLab's own type vocabulary is `issue` / `incident` / `test_case` / `task`, which has no member
meaning "bug", and `bug` is exactly what intake defaults the predicate to, so a GitLab intake
narrows to bugs through a label instead.

This also fixes a live mis-routing the previous slice opened: the bug hunt mapped a caller's board
id onto the leg its provider reads with an `if`-chain that fell through to the opaque
deployment-registered leg, so every GitLab hunt handed its project path to a field no built-in
provider reads and reported an empty board. It is now an exhaustive record over the built-in
vocabulary, so a fifth built-in source fails to compile until it names its leg.

A predicate a source cannot evaluate is now declared rather than dropped in silence. GitLab and
Linear both ignore `issueType`, and both intake forms rendered the field anyway, so an operator
configuring a schedule saw a filter that was never applied: on an unattended `bug-intake` schedule,
whose default is `bug`, that starts the bugfix pipeline on whatever is oldest and open. A provider
now states its gaps on `TaskSourceProvider.ignoredIntakePredicates`, `TaskSourceState` carries them
to the SPA, and the recurring-schedule and bug-hunt modals replace the field with what to narrow
with instead. `intakePredicateSupport.test.ts` keeps a declaration honest by compiling each source's
query with and without each predicate, so the answer is read off the compiler rather than restated
beside it.

Two GitLab-specific corrections ride along. The intake walk now pages on GitLab's own
`Link: rel="next"` (carried out on the new `ProjectIssuePage`) instead of treating a short page as
the last one: `max_page_size` is an instance setting an administrator can lower below the overscan
size, and on such an instance every page is short, so the walk stopped after page 1 and reported a
board it never finished as exhausted. And a walk whose workspace has no GitLab connection now
refuses instead of returning an empty list, which the intake step renders as the cause of a
no-pickup fire rather than as "no matching open issues".

`ProjectIssuePage` replaces the bare hit array `VcsClient.searchProjectIssues` /
`GitHubClient.searchProjectIssues` returned. Both are internal ports with one implementation.
