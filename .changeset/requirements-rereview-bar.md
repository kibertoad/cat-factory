---
'@cat-factory/contracts': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/conformance': minor
'@cat-factory/server': minor
'@cat-factory/app': minor
'@cat-factory/sdk': minor
'@cat-factory/gatekeeper-bindings': minor
'@cat-factory/mcp-server': minor
---

A requirements re-review is held to a bar: a new finding must be `high`, or follow up on an answer the previous round gave. The reviewer's user prompt lists that round's answers (each under a ref such as `A1`) and dismissals and asks for a `followsUp` citation (`requirement-review` prompt v8). The engine resolves each citation against the refs it handed out, drops what clears neither half, and records the count as `findingFloor.followUpSuppressed`. A kept follow-up carries the answered finding's title as `followsUpOn`, which the review window shows. Clarity and brainstorm re-reviews are unchanged.

`incorporate` takes an optional `after`: `rereview` (the default, unchanged) or `proceed`, which folds the answers in and settles the review on the result with no reviewer pass, advancing the run. The review window replaces "Incorporate answers" with "Incorporate and re-review" and "Incorporate and proceed". The three `/api/v1` incorporate decisions accept the same field, `PublicRequirementsFindingFloor` gains `followUpSuppressed`, and `PublicReviewFinding` gains `followsUpOn`: the OpenAPI surface is 1.93.0, and the SDKs are regenerated.
