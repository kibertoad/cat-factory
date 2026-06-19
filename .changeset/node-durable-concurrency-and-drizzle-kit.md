---
'@cat-factory/node-server': minor
---

Harden and scale the Node runtime's durable execution, and move its schema to a
drizzle-kit migration lineage.

- **Parallel execution.** The pg-boss execution worker now drives up to
  `EXECUTION_CONCURRENCY` runs in parallel (independent per-node workers, `batchSize`
  kept at 1 so per-run retry semantics are unchanged). Previously a single worker drove
  one run at a time — and because a drive parks for the whole of a step's poll budget,
  one slow run blocked every other run behind it.
- **Robust job liveness.** Advance jobs now carry a `heartbeatSeconds` so a crashed/
  evicted worker is detected and its run re-driven within ~1 minute, independent of the
  job-expiry cap. That cap (`expireInSeconds`) is now sized off the full-pipeline
  worst case (one poll budget × `EXECUTION_MAX_DRIVE_STEPS`, covering agent steps plus a
  CI-fixer retry loop) so a healthy long drive is never force-expired and double-driven
  under concurrency. New env knobs: `EXECUTION_CONCURRENCY`, `EXECUTION_HEARTBEAT_SECONDS`,
  `EXECUTION_MAX_DRIVE_STEPS` (`EXECUTION_DRIVE_EXPIRE_MINUTES` still overrides the cap).
- **drizzle-kit migrations.** The hand-written `CREATE TABLE IF NOT EXISTS` bootstrap is
  replaced by a generated drizzle-kit lineage applied at boot via the drizzle migrator
  (still under an advisory lock for concurrent-boot safety). `src/db/schema.ts` is now the
  single source of truth — additive schema changes ship as new migrations instead of
  silently diverging existing databases. The schema also gains the indexes the Cloudflare
  D1 store has but the Node store was missing — `idx_workspaces_owner`,
  `idx_workspaces_account`, `idx_agent_runs_workspace`, and the **unique** partial
  `idx_accounts_personal` (one personal account per GitHub login, a correctness constraint
  that was absent on Node).
