-- The workspace CONSENSUS-GROUP library, plus the transcript columns that record which group
-- a session actually ran.
--
-- A consensus group is a named, reusable panel — participants (role + perspective framing +
-- model), the strategy that runs them, the synthesizer — carrying the ESTIMATE BAR a task must
-- clear to earn it. A pipeline step names a SET of groups (`pipelines.consensus[i].groupIds`,
-- inside the existing JSON column, so no schema change there) and the engine selects the most
-- demanding tier the task's estimate clears at dispatch (`selectConsensusGroup`). That is what
-- turns "a light duo above 0.4 risk, the full panel above 0.8" into ONE step instead of three
-- conditional ones, and it is what makes the panels reusable across the review steps of every
-- pipeline in the workspace.
--
-- `gating` is stored as JSON rather than three nullable columns because it is read as a whole
-- (the bar is a unit: enabled + up to three axes + the missing-estimate disposition) and never
-- filtered on in SQL — the tier selection happens in TypeScript over the batch this table
-- returns, so no axis is ever a query predicate.
--
-- `consensus_sessions.group_id` / `group_name` record the tier that fired. The NAME is copied,
-- not joined: a library row can be renamed or deleted after the run, and a transcript that then
-- said nothing about which panel produced it would be unreadable exactly when someone is asking
-- why five models ran on their task.
--
-- Mirrors the Drizzle `consensusGroups` table + the two `consensusSessions` columns on the Node
-- facade.

CREATE TABLE IF NOT EXISTS consensus_groups (
  workspace_id         TEXT    NOT NULL,
  id                   TEXT    NOT NULL,
  name                 TEXT    NOT NULL,
  description          TEXT,
  strategy             TEXT    NOT NULL,        -- specialist-panel | debate | ranked-voting
  participants         TEXT    NOT NULL DEFAULT '[]',  -- JSON ConsensusParticipant[]
  synthesizer_model_id TEXT,
  rounds               INTEGER,                 -- debate rounds (1..5); null ⇒ engine default
  gating               TEXT    NOT NULL,        -- JSON ConsensusGating (this group's bar)
  created_at           INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, id)
);

-- The two read shapes are the library listing and the dispatch-path `listByIds`; both lead with
-- the workspace, which the primary key already covers. The listing orders by `created_at`, so
-- give it the composite rather than making every board load sort in memory.
CREATE INDEX IF NOT EXISTS idx_consensus_groups_workspace
  ON consensus_groups (workspace_id, created_at);

ALTER TABLE consensus_sessions ADD COLUMN group_id TEXT;
ALTER TABLE consensus_sessions ADD COLUMN group_name TEXT;
