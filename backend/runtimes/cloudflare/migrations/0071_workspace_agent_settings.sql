-- Per-workspace, per-agent-kind generation settings, edited from the pipeline builder.
--
-- The deployment routes each agent kind to a model with generation settings (AGENT_ROUTING /
-- AGENT_MODELS); this is the WORKSPACE tier of the output-token ceiling in there, because the
-- right ceiling is a property of the work a kind does — a kind whose whole deliverable is one
-- reply needs a budget its artifact fits in — and that is a judgement the workspace authoring
-- the pipelines makes, not the operator who set the deployment default once.
--
-- PLAIN, not append-only (contrast `agent_prompt_revisions`, whose log exists because
-- last-write-wins would silently discard a body of authored text). Here the value is one scalar
-- a human typed: a lost update costs the loser a number they can see is wrong and retype, so an
-- upsert keyed on the primary key is the right concurrency story and a revision log would be
-- ceremony.
--
-- No row for a kind ⇒ inherit the deployment routing default. `max_output_tokens IS NULL` says
-- the same thing explicitly, which is what lets the settings UI show "inheriting" as a state
-- without having to delete the row to express it.
--
-- Mirrors the Drizzle `workspace_agent_settings` table on the Node facade.
CREATE TABLE workspace_agent_settings (
  workspace_id      TEXT    NOT NULL,
  agent_kind        TEXT    NOT NULL,
  max_output_tokens INTEGER,
  updated_at        INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, agent_kind)
);

-- The primary key already serves both reads this store has: the dispatch path's point read on
-- (workspace_id, agent_kind) and the settings/builder read of one workspace's rows, which is a
-- prefix scan on workspace_id. So no secondary index — one would be dead weight on every write.
