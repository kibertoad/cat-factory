-- `subscription_activations.execution_id` becomes `scope_id`.
--
-- The column has never been a run id in the sense its name claimed. It holds an ACTIVATION SCOPE:
-- an opaque key naming what a system-key-only copy of a personal credential belongs to. A run was
-- the first kind, an environment test already writes its own `envtest_*` id here, and a signed-in
-- person on a run-less surface (the in-app assistant, the bug hunt) is now a third. With a second
-- and third kind on the same column, `execution_id` no longer describes what a reader will find:
-- a value nothing named `execution` will ever settle.
--
-- Values are re-minted rather than migrated. Every scope is now prefixed by its kind
-- (`run:<executionId>` / `user:<userId>`, see kernel's `runActivationScope` /
-- `userActivationScope`), so pre-existing rows carry unprefixed keys nothing will look up again.
-- They are dropped rather than rewritten: an activation is a 12h cache of a credential the user
-- can always re-unlock with their password, and inventing a prefix for a row whose kind is not
-- recorded would be a guess. Backwards compatibility is a non-goal for internal state.
--
-- SQLite's ALTER TABLE ... RENAME COLUMN carries the index definitions with it, so the unique
-- index is dropped and recreated under its new name rather than left describing a column spelling
-- nothing else uses.

DELETE FROM subscription_activations;

DROP INDEX IF EXISTS idx_sub_activations_run;

ALTER TABLE subscription_activations RENAME COLUMN execution_id TO scope_id;

CREATE UNIQUE INDEX idx_sub_activations_scope
  ON subscription_activations (scope_id, user_id, vendor);
