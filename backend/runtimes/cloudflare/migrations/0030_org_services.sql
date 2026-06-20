-- In-org shared services. Until now a "service" was a workspace-local frame block
-- ((workspace_id, id)) and everything — its tasks, executions, linked repo and sync —
-- hung off a single workspace, so two teams in one org could not share a service and a
-- shared repo got synced once per workspace. This migration introduces the account-owned
-- service as the canonical unit, with workspaces becoming curated VIEWS that *mount* it:
--
--   * `services` — one account-owned service per service frame; owns the frame's subtree
--     and (when connected) the GitHub repo its tasks target.
--   * `workspace_services` — a *mount*: a service placed onto a workspace board, carrying
--     the per-workspace layout override (frame position/size). The same service may be
--     mounted onto several workspaces in the same account.
--
-- The backfill is additive and idempotent: every existing top-level frame becomes a
-- service owned by its workspace's account, mounted into exactly that one workspace at
-- its current board position. Existing workspace-scoped behaviour is unchanged until the
-- read paths switch to service scope in a follow-up; the service id is derived
-- deterministically from (workspace_id, frame_block_id) so a re-run is a no-op.

CREATE TABLE services (
  id              TEXT    NOT NULL PRIMARY KEY,
  account_id      TEXT,                          -- owning account; NULL for legacy/unscoped
  frame_block_id  TEXT    NOT NULL,              -- the service frame block this service owns
  installation_id INTEGER,                       -- GitHub App installation backing the repo
  repo_github_id  INTEGER,                       -- linked repo's GitHub numeric id
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_services_account ON services (account_id);
CREATE INDEX idx_services_frame ON services (frame_block_id);
-- Resolve the service that owns a repo (the sync-dedup lookup).
CREATE INDEX idx_services_repo ON services (installation_id, repo_github_id);

CREATE TABLE workspace_services (
  workspace_id TEXT    NOT NULL,
  service_id   TEXT    NOT NULL,
  pos_x        REAL    NOT NULL DEFAULT 0,       -- per-workspace frame position override
  pos_y        REAL    NOT NULL DEFAULT 0,
  width        REAL,                             -- per-workspace dragged size; NULL = auto-size
  height       REAL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, service_id)
);
-- Fan events out to every workspace mounting a changed service.
CREATE INDEX idx_workspace_services_service ON workspace_services (service_id);

-- Backfill: one account-owned service per existing top-level frame.
INSERT INTO services (id, account_id, frame_block_id, installation_id, repo_github_id, created_at)
SELECT
  b.workspace_id || ':' || b.id,
  w.account_id,
  b.id,
  r.installation_id,
  r.github_id,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM blocks b
JOIN workspaces w ON w.id = b.workspace_id
LEFT JOIN github_repos r
  ON r.workspace_id = b.workspace_id AND r.block_id = b.id AND r.deleted_at IS NULL
WHERE b.level = 'frame' AND b.parent_id IS NULL;

-- Backfill: mount each frame's service onto its workspace at the frame's current layout.
INSERT INTO workspace_services (workspace_id, service_id, pos_x, pos_y, width, height, created_at)
SELECT
  b.workspace_id,
  b.workspace_id || ':' || b.id,
  b.pos_x,
  b.pos_y,
  b.width,
  b.height,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM blocks b
WHERE b.level = 'frame' AND b.parent_id IS NULL;
