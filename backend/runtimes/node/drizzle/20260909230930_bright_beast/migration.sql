-- `subscription_activations.execution_id` becomes `scope_id`, mirroring D1 0103.
--
-- The column holds an ACTIVATION SCOPE: an opaque key naming what a system-key-only copy of a
-- personal credential belongs to. A run was the first kind, an environment test already writes its
-- own `envtest_*` id here, and a signed-in person on a run-less surface is now a third.
--
-- Existing rows are DELETED rather than rewritten. Every scope is now prefixed by its kind
-- (`run:` / `user:`, minted by kernel's `runActivationScope` / `userActivationScope`), so an
-- unprefixed key will never be looked up again, and a row does not record which kind it was: a
-- prefix chosen here would be a guess. An activation is a 12h cache of a credential the user can
-- re-unlock with their password at any time.
DELETE FROM "subscription_activations";--> statement-breakpoint
ALTER TABLE "subscription_activations" RENAME COLUMN "execution_id" TO "scope_id";--> statement-breakpoint
ALTER INDEX "idx_sub_activations_run" RENAME TO "idx_sub_activations_scope";