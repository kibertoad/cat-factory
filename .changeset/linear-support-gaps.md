---
'@cat-factory/integrations': minor
'@cat-factory/contracts': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/app': minor
---

Fill the gaps in Linear support:

- **Connection pagination**: the Linear task source now walks the `children` and
  `comments` GraphQL connection cursors, so an epic with more than one page of
  sub-issues imports its full child set (no longer silently capped at ~50) — matching
  the Jira provider's epic-children pagination.
- **Team picker for ticket filing**: a new `GET /workspaces/:ws/task-sources/linear/teams`
  endpoint lists the connected workspace's Linear teams, and the issue-tracker settings
  UI offers a team dropdown instead of requiring a hand-pasted team UUID.
- **OAuth connect flow**: Linear can now be connected via OAuth ("Connect with Linear")
  in addition to a personal API key. New deployment config `LINEAR_OAUTH_CLIENT_ID` /
  `LINEAR_OAUTH_CLIENT_SECRET` / `LINEAR_OAUTH_REDIRECT_URL` (absent ⇒ only the manual
  API-key path is offered). The exchanged access token is stored as the connection and
  used as a `Bearer` token across import, search, ticket filing and PR writeback.
- **Search exact-ref match**: pasting a Linear issue identifier or URL into search now
  resolves and surfaces that exact issue first (de-duped against the term hits), like the
  GitHub Issues source.
