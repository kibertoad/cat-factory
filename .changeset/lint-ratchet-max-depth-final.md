---
'@cat-factory/kernel': patch
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
'@cat-factory/integrations': patch
'@cat-factory/observability-otel': patch
---

Lint ratchet: complete `max-depth` (5 → 4, its final target; no behavioural change).

Refactored the 18 depth-5 sites down to ≤ 4 by hoisting the innermost loop bodies into
helpers along cohesive seams:

- Extract a shared `parseSubtasks` into `@cat-factory/kernel` (`domain/subtasks.logic.ts`)
  and replace the four duplicated row→domain copies in the D1 and Drizzle bootstrap /
  env-config-repair repositories (removing the 4× duplication as well as the depth).
- Split the two Worker `ExecutionWorkflow` poll loops (`drivePollLoop` / `driveGatePollLoop`
  - a shared `pollOnce`), the benchmark harness's per-task fixture dispatch, the seed-dump
    child scan and the env-config bootstrap commit/PR path in `@cat-factory/integrations`, the
    Workers-AI assistant tool-call conversion, and the OTEL conformity metric fold into helpers.
- Lower `max-depth` to `4` in `.oxlintrc.json`.
