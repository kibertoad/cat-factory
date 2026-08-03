-- Two queryable projections behind the operator dashboard
-- (docs/initiatives/platform-operator-observability.md, slices 4b and 7).
--
-- `gate_outcomes`: one flat row per SETTLED polling gate. The live gate state (`attempts`,
-- `attemptLog`, the escalation phase) lives inside the per-run `detail` JSON blob as
-- `steps[].gate.*`, which is right for the run window and unusable for a rollup: aggregating it
-- would mean `json_each` here and `jsonb_array_elements` on Postgres, both reaching into the
-- engine's internal step-serialization shape, and neither expressible as one GROUP BY. So the
-- engine writes the terminal verdict as columns and the rollup is an ordinary aggregate.
--
-- The id is DERIVED by the writer as `<runId>:<stepIndex>:<outcome>` rather than minted, so the
-- durable drivers' replays collapse onto one row instead of inflating every statistic the table
-- exists to report; a step re-run that ends DIFFERENTLY still records its own row.
CREATE TABLE gate_outcomes (
  id              TEXT    NOT NULL,
  workspace_id    TEXT    NOT NULL,
  execution_id    TEXT    NOT NULL,
  block_id        TEXT    NOT NULL,
  gate_kind       TEXT    NOT NULL,            -- the gate step's agent kind (`ci`, `conflicts`, …)
  helper_kind     TEXT,                        -- the escalation agent (`ci-fixer`, …), or NULL
  outcome         TEXT    NOT NULL,            -- 'passed' | 'exhausted'
  attempts        INTEGER NOT NULL DEFAULT 0,  -- helper dispatches spent (0 = precheck-clean)
  max_attempts    INTEGER NOT NULL DEFAULT 0,
  helper_failures INTEGER NOT NULL DEFAULT 0,  -- helper jobs that themselves failed
  duration_ms     INTEGER,                     -- gate entry → verdict, NULL when unknown
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (id)
);

-- The rollup's access path: every read is "this account's workspaces, settled since T".
CREATE INDEX idx_gate_outcomes_workspace_created ON gate_outcomes (workspace_id, created_at);
-- The retention prune's access path (a global range delete, not workspace-scoped).
CREATE INDEX idx_gate_outcomes_created ON gate_outcomes (created_at);

-- `platform_run_days`: the daily rollup of `agent_runs` that serves the dashboard's `30d` and
-- `90d` windows. Those windows exist BECAUSE of this table: scanning a quarter of every run the
-- deployment ever made, on each dashboard load and each alert sweep, is the cost the rollup
-- removes, and it produces a series nobody can read at finer resolution anyway.
--
-- `failure_kind` uses '' (never NULL) for a non-failed status, because it is part of the primary
-- key: SQLite permits NULLs in a PK and does NOT treat two of them as equal, so a nullable column
-- here would let the same bucket be inserted repeatedly and silently double-count the day. The
-- repository maps '' back to NULL at the read boundary, so the port's shape is unaffected.
--
-- Rewritten in place by the sweep (`INSERT … ON CONFLICT DO UPDATE`), never appended: a day's
-- counts are not final until the day is over, so the current day must be CORRECTED on each pass
-- rather than frozen at whatever it held when it was first written.
CREATE TABLE platform_run_days (
  workspace_id TEXT    NOT NULL,
  day_start    INTEGER NOT NULL,           -- UTC-midnight epoch ms
  status       TEXT    NOT NULL,
  failure_kind TEXT    NOT NULL DEFAULT '', -- '' for every status but 'failed' (see above)
  run_count    INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, day_start, status, failure_kind)
);

-- The prune's access path; the account-scoped read rides the primary key's leading columns.
CREATE INDEX idx_platform_run_days_day ON platform_run_days (day_start);
