-- Epics + dependency-graph enhancements.
--
-- 1. `epic_id`: a task's membership link to an `epic`-level block. An epic groups
--    tasks that may live under different modules/services, so this is INDEPENDENT of
--    `parent_id` (the structural container) — deleting an epic only clears this link,
--    it never cascades the member tasks. NULL ⇒ the task is not in an epic.
--    (`level` is free-text, so the new 'epic' level needs no schema change.)
ALTER TABLE blocks ADD COLUMN epic_id TEXT;

-- 2. `auto_start_dependents`: preceding-task toggle (0/1). When a task with this set
--    reaches `done` (its PR merged), the engine auto-starts every task that depends on
--    it whose other dependencies are also done. NULL ⇒ off.
ALTER TABLE blocks ADD COLUMN auto_start_dependents INTEGER;

CREATE INDEX idx_blocks_epic ON blocks (workspace_id, epic_id);
