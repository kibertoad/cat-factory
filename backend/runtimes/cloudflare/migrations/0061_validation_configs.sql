-- Pre-PR validation checks: the shell commands the executor-harness runs against the
-- checkout after the coding agent settles and BEFORE the PR opens, keyed by SERVICE FRAME
-- block (a run resolves its checks by walking its block up the frame chain).
-- `checks` is a JSON array of `{ label, command }`. Mirrors the Drizzle `validation_configs`
-- table on the Node facade. See docs/initiatives/pre-pr-validation.md.
CREATE TABLE validation_configs (
  workspace_id    TEXT    NOT NULL,
  block_id        TEXT    NOT NULL,
  checks          TEXT    NOT NULL DEFAULT '[]',
  max_attempts    INTEGER NOT NULL DEFAULT 3,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, block_id)
);
