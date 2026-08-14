-- Task swimlanes: the board lays a service frame's tasks out in status lanes rather than at
-- hand-placed coordinates, which needs two things the schema could not answer.
--
-- 1) `blocks.completed_at` — the "Done" lane hides a task once it is older than the
--    workspace's retention window, and `blocks` carried NO timestamp of any kind, so there
--    was nothing to age a completed task by. Nullable and NOT backfilled: nothing records
--    when the tasks already merged reached `done`, and inventing a date would be exactly the
--    guess the lane's age filter must not make. Absent therefore means "no recorded
--    completion date" and the board EXEMPTS such a task from the age cap (the count cap
--    still bounds it), rather than treating it as ancient and hiding history on the strength
--    of a timestamp nobody wrote.
--
--    Stamped by the block repository at its single `update` funnel, not by the several
--    services that mark a task done, and first-write-wins via COALESCE so a replaying
--    durable driver cannot push the date forward. Cleared when a block leaves `done`, so a
--    reset-and-rerun is dated by the attempt that actually landed.
--
-- 2) The two Done-lane caps on `workspace_settings`. Both are per-workspace because what a
--    board shows is a shared decision, unlike the sort/group preference, which is per user
--    and lives in the browser. Defaults match DEFAULT_WORKSPACE_SETTINGS (20 cards / 14
--    days) so every existing row is valid and behaves identically to a fresh one.
ALTER TABLE blocks ADD COLUMN completed_at INTEGER;

ALTER TABLE workspace_settings ADD COLUMN done_lane_max_items INTEGER NOT NULL DEFAULT 20;
-- Nullable on purpose: NULL means "no age cap", which is a setting an operator can choose,
-- distinct from the default 14 days.
ALTER TABLE workspace_settings ADD COLUMN done_lane_retention_days INTEGER DEFAULT 14;
