-- Workspace-level RBAC & membership (see backend/docs/adr/0025-workspace-rbac.md). The tier BELOW
-- account tenancy: an account admin can restrict a board to an explicit member roster with
-- per-member workspace roles. Mirrors the Node/Drizzle `workspace_members` table + the
-- `workspaces.access_mode` column (migration 20260716150654_fast_dracula) — keep the runtimes
-- symmetric. D1 does not enforce foreign keys, so the workspace-delete cascade
-- (WORKSPACE_SCOPED_TABLES lists `workspace_members`) is what reclaims a deleted board's roster.

-- Access mode: 'account' (default — every account member sees the board, the legacy behaviour)
-- or 'restricted' (only the explicit member roster). The default means zero change to existing rows.
ALTER TABLE workspaces ADD COLUMN access_mode TEXT NOT NULL DEFAULT 'account';

CREATE TABLE workspace_members (
  workspace_id     TEXT    NOT NULL,   -- the board this membership scopes
  user_id          TEXT    NOT NULL,   -- the internal users(id)
  role             TEXT    NOT NULL,   -- single value: admin | member | viewer (strict hierarchy)
  created_at       INTEGER NOT NULL,
  added_by_user_id TEXT,               -- audit: who granted; null for system grants (creator auto-enroll)
  PRIMARY KEY (workspace_id, user_id)
);

-- Drives listWorkspaceIdsForUser + the workspace-list visibility subquery.
CREATE INDEX idx_workspace_members_user ON workspace_members (user_id);
