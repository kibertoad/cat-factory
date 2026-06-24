-- Issue-tracker writeback: comment on a task's linked tracker issue(s) when its PR
-- opens, and comment + close as resolved when it merges.
--
-- 1. Workspace-level toggles on the existing tracker settings (default off). Writeback
--    applies to a task's linked issues of any source, independent of the filing tracker.
ALTER TABLE tracker_settings ADD COLUMN writeback_comment_on_pr_open INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tracker_settings ADD COLUMN writeback_resolve_on_merge INTEGER NOT NULL DEFAULT 0;

-- 2. Per-task overrides ('on' | 'off'; NULL ⇒ inherit the workspace toggle above).
ALTER TABLE blocks ADD COLUMN tracker_comment_on_pr_open TEXT;
ALTER TABLE blocks ADD COLUMN tracker_resolve_on_merge TEXT;
