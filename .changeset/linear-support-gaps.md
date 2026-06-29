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
  UI offers a searchable (typeahead) team picker instead of requiring a hand-pasted team
  UUID.
- **OAuth connect flow**: Linear can now be connected via OAuth ("Connect with Linear")
  in addition to a personal API key. The OAuth app credentials (client id / secret /
  redirect URL) are configured **per account in the UI** (account Deployment settings,
  sealed in the DB and resolved dynamically — mirroring the Slack OAuth model), NOT via
  env vars, so an admin can set/rotate them without a redeploy. Absent ⇒ only the manual
  API-key path is offered. The exchanged access token is stored as the connection and
  used as a `Bearer` token across import, search, ticket filing and PR writeback.
- **Search exact-ref match**: pasting a Linear issue identifier or URL into search now
  resolves and surfaces that exact issue first (de-duped against the term hits), like the
  GitHub Issues source.
