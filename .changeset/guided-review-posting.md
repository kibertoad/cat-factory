---
'@cat-factory/contracts': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/sdk': minor
'@cat-factory/mcp-server': minor
'@cat-factory/gatekeeper-bindings': minor
'@cat-factory/app': minor
---

Guided PR review drafts can be edited and posted (surface version 1.77.0). An edit names the `rev` it was made against and is refused `409 draft_conflict` from a stale one; moving a draft is checked against the diff and refused `422 draft_anchor_outside_diff` outside it. Posting publishes the chosen drafts on the pull request as plain review comments under the caller's credential scope, with comment bodies scrubbed of secrets and passed through the host-markdown boundary. Each draft is claimed before the host call and settled with the host's own per-comment answer, so a retried post never publishes a comment twice and a partial post is reported per draft. A post after the pull request moved past the reviewed commit is refused `409 session_stale`.

The optional summary comment posts only alongside a draft the call claimed, so an identical retry after a complete post publishes nothing. Contracts export `isPostableDraft` and `GUIDED_REVIEW_POST_LEASE_MS`, the rule the server claims by and the review window selects by, so a `posting` draft whose poster died is offered for posting again once its lease ends. `ConflictError` gains `draft_conflict` and `session_stale`, translated in every locale. The four SDKs and the MCP server gain `editDraft` and `postDrafts`.
