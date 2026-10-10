-- Opt-in review-debt friction on task creation (backend/docs/review-debt-friction.md).
-- Four per-workspace knobs, off by default: the mode ('off'|'warn'|'enforce'), the soft
-- warn threshold (count of tasks in human review, default 3), and the two nullable hard-block
-- triggers (a count and a stuck-age in minutes). Mirrors the Drizzle columns on
-- workspace_settings. Defaults make every existing row valid with friction disabled.
ALTER TABLE workspace_settings ADD COLUMN review_friction_mode TEXT NOT NULL DEFAULT 'off';
ALTER TABLE workspace_settings ADD COLUMN review_friction_warn_count INTEGER NOT NULL DEFAULT 3;
ALTER TABLE workspace_settings ADD COLUMN review_friction_block_count INTEGER;
ALTER TABLE workspace_settings ADD COLUMN review_friction_block_stuck_minutes INTEGER;
