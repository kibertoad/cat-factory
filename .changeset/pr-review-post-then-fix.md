---
'@cat-factory/contracts': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/conformance': minor
'@cat-factory/app': patch
'@cat-factory/sdk': minor
'@cat-factory/gatekeeper-bindings': minor
'@cat-factory/mcp-server': minor
---

A PR deep review can comment on some findings and fix others in one resolution. A `post`
resolution accepts `fixFindingIds` beside `findingIds`: the selected findings are posted as inline
comments first, and once every comment has landed the same step is handed to the Fixer for the
queued findings, whose completion settles the review. The post goes first because its comments
anchor to the reviewed head, which the Fixer's pushes would move.

- `POST /api/v1/runs/{runId}/decisions/pr-review/resolve` (and the internal resolve route) accept
  an optional `fixFindingIds`. It is honoured only with `action: 'post'`; any other action carrying
  a non-empty list is refused with `409`. Unknown and retracted ids are dropped as for
  `findingIds`.
- The `pr-review` decision gains `fixFindingIds: string[]`, always present (empty by default),
  listing what is queued for the Fixer.
- A partial or failed post re-parks the review at `awaiting_selection` with the queue cleared, so
  the curator re-resolves with both lists.
- `prReview.fixFindingIds` is new on the persisted `pr-reviewer` step state.

OpenAPI surface version 1.90.0. Additive; the SDKs are regenerated, and the TypeScript SDK's
`decisions.resolvePrReview` takes `fixFindingIds`.
