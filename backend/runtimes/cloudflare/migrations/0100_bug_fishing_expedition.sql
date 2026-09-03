-- Bug-fishing expeditions.
--
-- Two columns, and no table: the expedition's own state (its angles, its catch, the fix task each
-- marked finding spawned) rides the run's `bug-fisher` step in the execution row's `detail` blob,
-- exactly as the PR review's does, so it needs no schema of its own and stays runtime-symmetric by
-- construction.
--
-- What DOES need columns is the pair of links a blob cannot hold:
--
--   * `blocks.expedition_id` — the spawned fix task's link back to the expedition that found the
--     defect. Mirrors `initiative_id` (migration 0035) exactly, including its index, because it is
--     the same shape of fact: a membership link independent of `parent_id`, which stays the
--     enclosing service frame so the fix runs against the repo the expedition fished.
--   * `workspace_settings.bug_fishing_fix_pipeline_id` — which pipeline those spawned tasks run.
--     NULL means the built-in bug-fix preset, which is what every board gets until it picks one.

ALTER TABLE blocks ADD COLUMN expedition_id TEXT;
CREATE INDEX idx_blocks_expedition ON blocks (workspace_id, expedition_id);

ALTER TABLE workspace_settings ADD COLUMN bug_fishing_fix_pipeline_id TEXT;
