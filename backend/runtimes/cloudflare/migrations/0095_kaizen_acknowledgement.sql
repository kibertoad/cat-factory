-- Acknowledgement state on a Kaizen grading, plus the index its public list pages on.
--
-- A grading records how an agent step went and what to change about it. Until now nothing recorded
-- whether anyone had READ one, so the only way to consume them was a bounded newest-first history
-- that re-reports the same rows on every look. `GET /api/v1/kaizen/entries?acknowledged=false` is
-- the backlog that replaces it, and these columns are what takes an entry out of it.
--
-- `acknowledged_at`:      epoch ms of the FIRST acknowledgement (a repeat leaves it alone, so it
--                         names when the entry was triaged rather than when a retry last fired).
-- `acknowledged_by`:      the actor: a user id when the acting key is bound to a person, else the
--                         public-API key id, so a follow-up has somebody to go back to.
-- `acknowledgement_note`: what the acknowledger wanted the next reader to know (a ticket id, why
--                         it was dismissed).
--
-- All three are nullable with no default: unacknowledged is the state every existing row is in, and
-- writing them is never part of the grading sweep's upsert.
--
-- The index serves the list's `(workspace_id, created_at DESC, id DESC)` ordering. The existing
-- indexes cover the run window (workspace + execution) and the sweep (status + updated_at); neither
-- helps a workspace-wide chronological page.

ALTER TABLE kaizen_gradings ADD COLUMN acknowledged_at INTEGER;
ALTER TABLE kaizen_gradings ADD COLUMN acknowledged_by TEXT;
ALTER TABLE kaizen_gradings ADD COLUMN acknowledgement_note TEXT;

CREATE INDEX idx_kaizen_gradings_workspace_created
  ON kaizen_gradings(workspace_id, created_at);
