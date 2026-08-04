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
-- This is the FIRST migration of the dedicated `AUDIT_DB` database's own lineage, not of the
-- main one. The log lives apart because, once the run-lifecycle slice lands, it is the only table
-- in the platform that grows monotonically with run volume AND wants a multi-year window
-- (`token_usage` grows with runs but prunes at ~395 days; the telemetry sinks grow far faster but
-- prune at 3). On a store with a hard 10 GB per-database ceiling that combination is a capacity
-- question, and keeping it out of `DB` is what stops a years-deep trail from competing with live
-- transactional state. Measured at ~508 B/row on Postgres, so 1,000 runs/day is ~550 MB/year.
-- Mirrors the Node Drizzle `auditEvents` table (db/tables/audit.ts); keep in step.
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
