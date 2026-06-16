-- Workspace ownership. Until now every authenticated user could read and mutate
-- EVERY workspace (the table had no owner column, and no route checked one) — a
-- cross-tenant access-control hole. We add the owning GitHub user id so the API
-- can scope list/read/write to the owner.
--
-- The column is nullable so the migration is additive. Rows created before this
-- migration have NULL owner and are therefore NOT accessible once auth is
-- enabled (NULL never equals a signed-in user's id) — the fail-closed choice.
-- Such legacy boards must be re-created (or claimed by a manual UPDATE) by an
-- operator. When auth is disabled (local dev / AUTH_DEV_OPEN), ownership is not
-- enforced and all boards remain visible.
ALTER TABLE workspaces ADD COLUMN owner_user_id INTEGER;

CREATE INDEX idx_workspaces_owner ON workspaces (owner_user_id);
