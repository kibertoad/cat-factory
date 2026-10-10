-- Guided PR review: what kind of identity owns a session, and the order the public list pages in.
--
-- `created_by` holds a user id for a person and the key id for a public-API key bound to nobody.
-- The kind says which, so background work resolves a person's credentials only for a person and
-- the workspace's own for a key. Existing rows were all opened from the app, so they are `user`.
ALTER TABLE guided_review_sessions ADD COLUMN created_by_kind TEXT NOT NULL DEFAULT 'user';

-- The public list is a keyset page over (created_at, id), newest first.
CREATE INDEX idx_guided_review_sessions_created
  ON guided_review_sessions (workspace_id, created_at, id);
