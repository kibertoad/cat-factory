-- Per-workspace agent system-prompt overrides, edited from the pipeline builder.
--
-- APPEND-ONLY: one row per revision of one `(workspace, agent_kind)` prompt, and the HIGHEST
-- `revision` is the live one. Restoring an older prompt appends a copy of it (tagged with
-- `restored_from`) rather than moving a pointer, so going back never destroys history and the
-- live prompt is a single `ORDER BY revision DESC LIMIT 1` read instead of a log replay.
--
-- `text IS NULL` is the deliberate way back to the SHIPPED built-in prompt: it keeps the
-- workspace tracking the product's own prompt as it is bumped, which storing a copy of the
-- built-in's current text would not. It is distinct from having no rows at all (an untouched
-- kind) precisely so the history records that someone chose to revert.
--
-- The uniqueness on `(workspace_id, agent_kind, revision)` is load-bearing, not hygiene: the
-- next revision number is computed from a read, so it is what makes two concurrent editors
-- safe — the loser's INSERT collides and surfaces as a 409 instead of silently clobbering the
-- winner's text. Never turn this insert into an upsert.
--
-- Mirrors the Drizzle `agent_prompt_revisions` table on the Node facade.
CREATE TABLE agent_prompt_revisions (
  workspace_id  TEXT    NOT NULL,
  agent_kind    TEXT    NOT NULL,
  revision      INTEGER NOT NULL,
  text          TEXT,
  restored_from INTEGER,
  created_at    INTEGER NOT NULL,
  created_by    TEXT,
  PRIMARY KEY (workspace_id, agent_kind, revision)
);

-- The workspace-wide override index the pipeline builder badges its steps from reads every
-- kind's head in one query; without this the `MAX(revision) GROUP BY agent_kind` scan is over
-- the whole table rather than one workspace's slice.
CREATE INDEX idx_agent_prompt_revisions_workspace
  ON agent_prompt_revisions (workspace_id, agent_kind, revision DESC);
