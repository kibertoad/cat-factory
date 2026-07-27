-- Per-service ACCEPTANCE CRITERIA: durable given/when/outcome statements of required behaviour,
-- keyed by SERVICE FRAME block (a run resolves them by walking its block up the frame chain).
--
-- One ROW per criterion rather than one JSON blob per frame — unlike the neighbouring
-- `validation_configs` / `release_health_configs` — because each criterion carries its own
-- lifecycle (`proposed` from the accretion pass → `confirmed` / `retired` by a human) and its
-- own stable id, which the tester's per-criterion verdicts and the PR verification report
-- join on.
--
-- The clauses are stored as `*_text`: `when` is a reserved word in Postgres and `then` in both
-- dialects, so the suffixed names keep the Drizzle mirror and this table identical. `tags` is a
-- JSON array as text.
--
-- Mirrors the Drizzle `acceptance_criteria` table on the Node facade. See
-- docs/initiatives/acceptance-criteria-store.md.
CREATE TABLE acceptance_criteria (
  id                TEXT    NOT NULL PRIMARY KEY,
  workspace_id      TEXT    NOT NULL,
  block_id          TEXT    NOT NULL,
  title             TEXT    NOT NULL,
  given_text        TEXT    NOT NULL DEFAULT '',
  when_text         TEXT    NOT NULL DEFAULT '',
  outcome_text      TEXT    NOT NULL DEFAULT '',
  tags              TEXT    NOT NULL DEFAULT '[]',
  status            TEXT    NOT NULL DEFAULT 'proposed',
  provenance        TEXT    NOT NULL DEFAULT 'authored',
  source_review_id  TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

-- The frame-chain read on every dispatch (`WHERE workspace_id = ? AND block_id IN (…)`) and
-- the workspace hydrate both ride this index.
CREATE INDEX idx_acceptance_criteria_workspace_block
  ON acceptance_criteria (workspace_id, block_id);
