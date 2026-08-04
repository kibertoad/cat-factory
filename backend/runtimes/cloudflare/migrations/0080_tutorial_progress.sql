-- Per-user in-app tutorial progress. PK is the user id, like `user_settings` (migration 0042).
--
-- Mirrors the SPA's browser-persisted store so a person's walkthrough history follows THEM rather
-- than a browser profile: without it a second machine re-asks the launch question and re-makes
-- every contextual offer. Absence of a row is the "never touched the tutorial" state, which is
-- also what "Reset progress" restores (the row is deleted, never rewritten with defaults).
--
-- The two id lists are stored as JSON arrays rather than a join table on purpose: they are
-- grow-only sets of at most a few dozen opaque tour ids, always read and written whole, and
-- nothing joins or aggregates over them. `decision` is NULL when never answered, which is a real
-- state distinct from 'declined'.
CREATE TABLE tutorial_progress (
  user_id            TEXT    NOT NULL PRIMARY KEY,
  decision           TEXT,
  completed_tour_ids TEXT    NOT NULL DEFAULT '[]',
  nudged_tour_ids    TEXT    NOT NULL DEFAULT '[]',
  updated_at         INTEGER NOT NULL
);
