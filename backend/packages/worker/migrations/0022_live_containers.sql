-- Instance-level container reaping registry. Every safety net before this keyed
-- off the *run record* (agent_runs), never the actual container inventory — so a
-- container whose run record had already gone terminal, or whose run was stuck
-- `running` with a live driver holding it warm, could linger for ~a day, billed
-- and invisible to every net. This table is that missing inventory: one row per
-- live per-run Cloudflare Container, written at dispatch and removed when the
-- container is reclaimed, so an age-based cron reaper can kill anything that
-- outlived its legitimate maximum lifetime via the existing EXEC_CONTAINER binding
-- (no Cloudflare API token). Conventions per 0001/0019: INTEGER epoch-ms, no FKs.
--
--   container_key — the idFromName() argument the container is addressed by: the
--                   execution/bootstrap job id (also the run id). PRIMARY KEY, so a
--                   replayed dispatch is a no-op that preserves the first started_at.
--   kind          — the dispatch kind ('run' | 'blueprint' | 'bootstrap'); purely
--                   diagnostic, the kill is kind-agnostic (shutdown by key).
--   workspace_id  — diagnostic; nullable (the transport dispatch seam carries only
--                   the job id, not the workspace).
--   started_at    — epoch ms of the FIRST dispatch = the container's true age, which
--                   the reaper compares against its max-age ceiling.

CREATE TABLE live_containers (
  container_key TEXT    PRIMARY KEY,
  kind          TEXT    NOT NULL,
  workspace_id  TEXT,
  started_at    INTEGER NOT NULL
);
CREATE INDEX idx_live_containers_started ON live_containers (started_at);
