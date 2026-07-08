---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/app': minor
---

Requirements review UX + per-task risk policy rename + document default pipeline.

**Requirements review — per-finding recommendation guidance & inline recommendations.** Each
finding now has an explicit 3-way selector (Answer / Dismiss / Recommend) in place of the old
button row. Typing an answer marks the finding "You answered"; choosing **Recommend** carries
whatever you typed over as **per-finding guidance** that steers the Requirement Writer's
suggestion (shown on-screen as guidance, not saved as the answer). Recommendations now render
**inline inside their source finding card** — generating spinner, the ready suggestion with
accept/reject/re-request — instead of a separate section below. The request-recommendations wire
contract changes from `{ itemIds, note }` to `{ items: [{ itemId, note? }] }` so each finding in a
batch can steer the Writer differently.

**Auto-recommendation on every round.** Auto-recommendation now also runs after an off-path
re-review (not only the pipeline-driven incorporation cycle), so every iteration round that
introduces new questions gets its auto-answerable findings pre-answered.

**"Merge threshold preset" renamed to "Risk policy".** The per-task/per-workspace preset governs
merge ceilings, CI-fixer attempts, requirement/tester iteration caps and release-health watch — a
broader risk-management surface than "merge". It is renamed to **Risk policy** across the wire
contracts, kernel/domain types, services, HTTP routes (`/workspaces/:ws/merge-presets` →
`/risk-policies`), repositories, and the SPA (store/util/panel/i18n). `Block.mergePresetId` →
`Block.riskPolicyId`. Iteration caps stay on the policy (per your risk-management model) — no
functional change. The physical DB table/column names are retained internally (mapped to the new
domain names), so there is no data migration.

**Document tasks default to the document pipeline.** A `taskType: 'document'` task now defaults to
the document-authoring pipeline (`pl_document`) instead of the full-build pipeline, which produces
no code and needs no spec/tests. Overridable per task as before.
