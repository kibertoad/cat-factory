---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/integrations': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/app': minor
---

Surface external context sources in the add-task popup, with search + a new GitHub
repo-doc source.

The task-creation popup gains a `ContextPicker`: pick a connected source
(Confluence, Notion, GitHub repo docs, Jira, GitHub issues), then **search its
catalogue by title/content**, paste a page/issue URL, or pick something already
imported — chosen items are imported and linked to the new task as agent context
when it's created. Previously the popup could only tick already-imported items and
there was no in-UI way to reach the catalogue.

- **Search** is a new optional capability on the document/task source providers
  (`search?(credentials, query)`), exposed as `POST
/workspaces/:ws/{document,task}-sources/:source/search`. Implemented for
  Confluence (CQL), Notion (`/v1/search`), Jira (JQL), GitHub issues
  (`/search/issues`) and GitHub docs (`/search/code`). The `GitHubClient` port
  gains `searchIssues` / `searchCode`. Descriptors advertise `searchable` so the UI
  knows when to offer a search box.
- **GitHub repo docs** are a new `github` document source: link a Markdown/text
  file from a repo (README, RFC, architecture note) by URL or `owner/repo:path`, or
  by code-search. Like GitHub issues it reuses the workspace's installed GitHub App
  (no credentials of its own) and is wired only when the GitHub integration is on.
