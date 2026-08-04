-- The account audit log: an append-only record of who did what, when, for the privileged and
-- destructive actions an account admin is answerable for.
--
-- Append-only by design: nothing in the platform issues an UPDATE or a DELETE against this
-- table (the retention sweep is a later slice and is the only writer that ever will). That is
-- the property that makes the log worth reading, so it is a convention enforced by the absence
-- of repository methods rather than by a constraint.
--
-- `actor_kind` + the two nullable actor columns are a discriminated principal, not a nullable
-- user id: `system` (the engine acted) and an unresolved user are different facts, and a log
-- that renders them identically misattributes a human action to automation.
--
-- The read index is (account_id, at DESC, id DESC) because the viewer's ONLY read is one
-- account's newest-first page: `id` breaks the tie so two events recorded in the same
-- millisecond cannot straddle a page boundary and be served twice or skipped.
-- Mirrors the Node Drizzle `auditEvents` table (db/tables/identity.ts); keep in step.
CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  workspace_id TEXT,
  actor_kind TEXT NOT NULL,
  actor_user_id TEXT,
  actor_api_key_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX idx_audit_events_account_at ON audit_events (account_id, at DESC, id DESC);
