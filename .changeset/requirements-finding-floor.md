---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/conformance': minor
'@cat-factory/server': minor
'@cat-factory/app': minor
'@cat-factory/sdk': minor
'@cat-factory/gatekeeper-bindings': minor
'@cat-factory/mcp-server': minor
---

A risk policy now sets how verbose a requirements review is. `requirementFindingFloor` is the lowest severity the reviewer raises (`high`, `medium` or `low`). It defaults to `medium`, so `low` findings are no longer raised on existing policies either. `requirementFloorProgression` (null by default) moves that floor with the task estimate. Below `mediumFrom` only `high` is raised, from `mediumFrom` `high` and `medium`, and from `lowFrom` everything, read against the highest of the estimate's complexity, risk and impact. With no estimate on the task, the fixed floor applies. The reviewer prompt names the floor (`requirement-review` prompt v7), the engine drops anything returned below it, and each pass records the floor, where it came from and how many findings it dropped on `RequirementReview.findingFloor`. The review window shows that record, and the risk-policy editor gains the controls.

`reviewItemSeveritySchema` moves to the new `requirement-finding-floor` module of `@cat-factory/contracts` and is still exported from the package root. Migration: D1 `0112_requirement_finding_floor`, plus a Drizzle migration on Node, adds `requirement_finding_floor` and `requirement_floor_progression` to `merge_threshold_presets` and `account_risk_policies`, and `finding_floor` to `requirement_reviews`.

A requirements decision read through `/api/v1` carries the same record as `findingFloor` (`PublicRequirementsFindingFloor`, null on a review recorded without one), so a headless caller can tell a filtered review from one that found little: the OpenAPI surface is 1.91.0, and the SDKs are regenerated.
