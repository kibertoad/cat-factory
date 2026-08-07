-- Durable cost attribution: the daily spend rollup behind the Reports view's TCO axes.
--
-- The ledger (`token_usage`) already carries every metered call, but it cannot answer a TCO
-- question durably. It is pruned to TOKEN_USAGE_RETENTION_DAYS, and every attribution beyond
-- the workspace is resolved at READ time by joining `agent_runs` (itself prunable) and then
-- the LIVE `services.repo_github_id` / `tasks.linked_block_id` links. Re-point a service at a
-- new repository, or re-import an issue, and last quarter's answer changes underneath the
-- reader with nothing to show that it did.
--
-- So this table folds the ledger once per sweep, per UTC day, and FREEZES the board shape the
-- spend happened under: the run, its block and title, its service and name, its repository id
-- and `owner/name`, its task type, and the tracker ticket its block was linked to. Reading it
-- touches no other table, so nothing downstream of it can be re-pointed or pruned.
--
-- It has NO RETENTION, deliberately, and is the only table in the deployment that has none.
-- A TCO table has to outlive the ledger it was folded from; a rollup with a window is just a
-- slower ledger. The grain keeps that affordable: one row per run per (agent kind, model,
-- billing kind), a handful of rows against the hundreds of ledger rows one run writes, so the
-- table grows with RUN volume, never with call volume. See docs/storage-and-retention.md §1c.
--
-- KEY COLUMNS carry '' rather than NULL (SQLite does not treat two NULLs in a primary key as
-- equal, so a nullable key column would not deduplicate a rewritten bucket); the repository
-- maps '' back to the unattributed bucket at the read boundary, exactly as `platform_run_days`
-- does with `failure_kind`. LABEL columns stay nullable, because "no name" and "the empty
-- name" are the same absence there and the wire shape reports a nullable label.
CREATE TABLE IF NOT EXISTS spend_days (
  workspace_id TEXT NOT NULL,
  day_start INTEGER NOT NULL,
  -- The run the calls belong to; '' when the ledger row carried no execution id or the run
  -- row is already gone (the unattributed bucket, a real slice rather than a dropped row).
  execution_id TEXT NOT NULL DEFAULT '',
  agent_kind TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  -- Metered (real money) vs subscription (flat-rate quota usage, illustrative only). Part of
  -- the key so the two never have to be separated after the fact.
  billing TEXT NOT NULL DEFAULT 'metered',
  vendor TEXT NOT NULL DEFAULT '',
  -- The owning account, frozen so an account-scoped read never has to join `workspaces`: a
  -- board deleted since the spend happened must not take its history's scope with it.
  account_id TEXT NOT NULL DEFAULT '',
  workspace_name TEXT,
  block_id TEXT NOT NULL DEFAULT '',
  block_title TEXT,
  service_id TEXT NOT NULL DEFAULT '',
  service_name TEXT,
  -- The provider repo id as text (the `repo` dimension's key) and `owner/name` (its label).
  repo_id TEXT NOT NULL DEFAULT '',
  repo_name TEXT,
  task_type TEXT NOT NULL DEFAULT '',
  -- `source:externalId` of the lowest-sorting ticket linked to the run's block, matching the
  -- ledger-side dimension's deterministic pick. No title: a second MIN over another column
  -- need not come from the same row, and a label naming a different ticket than the key is
  -- worse than no label.
  ticket_ref TEXT NOT NULL DEFAULT '',
  calls INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  metered_cost REAL NOT NULL DEFAULT 0,
  subscription_cost REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (
    workspace_id, day_start, execution_id, agent_kind, provider, model, billing, vendor
  )
);

-- The read's access path: one account's (optionally one board's) buckets over a day window.
CREATE INDEX IF NOT EXISTS idx_spend_days_account ON spend_days (account_id, day_start);
-- The rewrite's access path: each pass DELETEs its whole day window across every workspace
-- before re-inserting it (an upsert is not a rewrite: see the repository).
CREATE INDEX IF NOT EXISTS idx_spend_days_day ON spend_days (day_start);
-- Per-run lookup (the finest TCO axis), independent of when the run happened.
CREATE INDEX IF NOT EXISTS idx_spend_days_execution ON spend_days (workspace_id, execution_id);
