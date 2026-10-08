---
'@cat-factory/contracts': minor
'@cat-factory/server': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/sdk': minor
'@cat-factory/mcp-server': minor
'@cat-factory/gatekeeper-bindings': minor
---

Guided PR review is on the public API (surface version 1.76.0). `/api/v1/guided-reviews` opens, lists, reads, refreshes and deletes sessions, opens threads, asks questions and requests comment drafts, and `GET /api/v1/guided-reviews/{sessionId}/events` streams the session view as it changes. Reading takes a `read` key; opening, asking and drafting take `write`, because they spend model budget, and nothing here posts to the pull request. A key bound to a person acts as that person; an unbound key owns its own sessions on the workspace's credentials, and a session's `createdByKind` says which of the two owns it. The session list is keyset-paginated, newest created first.

The four SDKs gain a `guidedReviews` resource group and the MCP server its tools (the stream excepted: a tool call has no streaming channel). Three value sets the new shapes share with earlier operations are pinned to their published type names, so no released SDK type is renamed.
