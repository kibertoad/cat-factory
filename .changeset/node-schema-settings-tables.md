---
'@cat-factory/node-server': patch
---

Move the SETTINGS tables (the local-mode singleton, the per-user budget, the per-workspace runtime
policy row and the per-agent-kind generation knob) out of `db/schema.ts` into
`db/tables/settings.ts`, re-exported — the same cohesive-group extraction `tables/identity.ts` and
`tables/vcs.ts` already got, so the module stays inside its size budget (ratcheted 1900 -> 1820)
while the workspace metadata column lands on it. drizzle-kit follows the re-export, so the generated
lineage is unchanged.
