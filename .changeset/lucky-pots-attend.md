---
'@cat-factory/contracts': minor
'@cat-factory/integrations': minor
'@cat-factory/kernel': patch
'@cat-factory/server': minor
'@cat-factory/conformance': patch
'@cat-factory/app': minor
---

A bug hunt on a repo-backed tracker scopes to the service's repository, not a picked board

GitHub Issues and GitLab Issues put every issue in one repository, and the only repository a hunt
may read is the one its service frame is linked to. Both now offer NO board control: the hunt
carries the container an adopted bug will land in, and the board is that container's service repo,
resolved through the same `resolveRepoTarget` walk an issue search scopes with (now shared as
`server/src/modules/tasks/sourceRepoScope.ts`). A board picker there could scan, rate and adopt a
bug from a repository nothing on the board points at, whose run would then open its PR somewhere
else entirely.

Internal wire break (`POST /workspaces/:ws/bug-hunt/:source/hunts`): the body now takes
`containerId` plus a REQUIRED, NULLABLE `board`. `null` is the only legal value for a repo-backed
source, and naming one there is refused (`details.reason: 'board_from_service'`) rather than
ignored; a repo-less source with no board is refused too. Board LISTING is refused for a repo-backed
source with the same reason, so `GitHubIssuesProvider.listBoards` and
`GitLabIssuesProvider.listBoards` are gone along with the shared `repoRefsToBoards` projection.
`TaskSourceState` gains `repoBacked` (derived from the provider's declared `repoScope`) so the SPA
knows which surface to render before it asks.

Every refusal now lands as soon as it is decidable, cheapest first: an unhuntable source on the
registry, then the board shape from the request body alone, then the repository walk, then the
container. So an unregistered source is refused by name instead of being told to pick a board it
has no control for, a board named beside an unlinked service no longer costs two round trips to
learn it was never allowed, and a `containerId` naming no block on this workspace refuses before
the vendor read and the ranking call rather than at adoption.
