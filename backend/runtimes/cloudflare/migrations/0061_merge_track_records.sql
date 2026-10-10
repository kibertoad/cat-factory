-- Merge TRACK RECORD: one row per merge decision, carrying the run's deterministic change
-- class, the merger's scores at the decision, what happened, and the reviewer-effort tag a
-- human left. Per-class rollups over this table are what justify widening a preset's per-class
-- auto-merge rule. Mirrored on Node by the Drizzle `mergeTrackRecords` pgTable.
-- See backend/docs/adr/0046-merge-track-record.md.
--
-- Row identity is DETERMINISTIC (`mtr_<executionId>`) and inserts are first-write-wins
-- (`ON CONFLICT(...) DO NOTHING` at the repository), so the durable driver re-resolving a merger
-- step whose merge already landed can neither duplicate a row nor clobber an effort tag.
--
-- Provider-neutral by construction: the repo identity is `repo_id` + `provider` (the VcsRepoRef /
-- VcsProvider vocabulary), never a GitHub-shaped numeric installation/repo id.
CREATE TABLE merge_track_records (
  workspace_id        TEXT    NOT NULL,
  id                  TEXT    NOT NULL,
  block_id            TEXT    NOT NULL,
  -- The run whose merger step wrote the record. Nullable at the column level; every record
  -- written today is born inside a run (an external merge SETTLES one, it never mints one).
  execution_id        TEXT,
  -- docs | test | dependency | config | source | schema | unknown (highest-rank class present).
  change_class        TEXT    NOT NULL,
  changed_file_count  INTEGER,
  -- The merger's 0..1 axes; null when it produced no parseable assessment (or never ran).
  complexity          REAL,
  risk                REAL,
  impact              REAL,
  risk_policy_id      TEXT,
  risk_policy_name    TEXT,
  -- pending_review | auto_merged | human_merged | external_merged | rejected.
  decision            TEXT    NOT NULL,
  -- none | minor | major. NULL until somebody tags it — tagging is a nudge, never a gate.
  review_effort       TEXT,
  pr_number           INTEGER,
  pr_url              TEXT,
  repo_id             TEXT,
  provider            TEXT,
  created_at          INTEGER NOT NULL,
  resolved_at         INTEGER,
  tagged_at           INTEGER,
  PRIMARY KEY (workspace_id, id)
);

-- The per-class rollup aggregate (`GROUP BY change_class` with conditional SUMs) reads a whole
-- workspace, so lead with (workspace_id, change_class).
CREATE INDEX idx_merge_track_records_class
  ON merge_track_records (workspace_id, change_class);
-- Settling a decision / tagging effort resolves by run.
CREATE INDEX idx_merge_track_records_execution
  ON merge_track_records (workspace_id, execution_id);
-- The block-scoped merge controls read the block's most recent record.
CREATE INDEX idx_merge_track_records_block
  ON merge_track_records (workspace_id, block_id, created_at);
-- External-merge attribution looks a record up by the PR the webhook named.
CREATE INDEX idx_merge_track_records_pr
  ON merge_track_records (workspace_id, repo_id, pr_number);

-- Per-change-class auto-merge rules on the merge preset, stored as a JSON partial map from
-- change class to `thresholds` | `always` | `never`. NOT NULL with a `{}` default, so an existing
-- row resolves to "use the score ceilings" for every class — the historical behaviour. Mirrored
-- on Node by the `class_rules` text column on the Drizzle `merge_threshold_presets` table.
ALTER TABLE merge_threshold_presets ADD COLUMN class_rules TEXT NOT NULL DEFAULT '{}';
