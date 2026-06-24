-- Run-timing rework + task types + per-service task limits.
--
-- 1. Tasks gain a type (feature/bug/document/spike/recurring) + small per-type form
--    fields. Both are task-level; absent ⇒ treated as a 'feature' with no extra fields.
ALTER TABLE blocks ADD COLUMN task_type TEXT;
ALTER TABLE blocks ADD COLUMN task_type_fields TEXT;

-- 2. Notifications gain a render severity. `normal` (yellow) until the escalation sweep
--    flips a long-waiting one to `urgent` (red) — the signal that replaced the old
--    hard "decision timeout" auto-fail. NULL is read as 'normal'.
ALTER TABLE notifications ADD COLUMN severity TEXT;

-- 3. Per-workspace runtime settings: the human-wait escalation threshold and the
--    per-service running-task limit policy. One row per workspace; lazily seeded.
CREATE TABLE workspace_settings (
  workspace_id               TEXT    NOT NULL PRIMARY KEY,
  waiting_escalation_minutes INTEGER NOT NULL DEFAULT 120,
  -- 'off' | 'shared' | 'per_type'
  task_limit_mode            TEXT    NOT NULL DEFAULT 'off',
  -- The shared cap when task_limit_mode = 'shared'; NULL otherwise.
  task_limit_shared          INTEGER,
  -- JSON object of per-type caps when task_limit_mode = 'per_type'; NULL otherwise.
  task_limit_per_type        TEXT
);
