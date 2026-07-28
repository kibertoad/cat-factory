-- Self-healing before constraining (mirror of D1 migration 0066): a deployment that already ran
-- the delete-then-insert publish path can hold duplicate live reviews for one block, and
-- CREATE UNIQUE INDEX would hard-fail on them. Delete every row that has a strictly newer sibling
-- in its group, so exactly the row `getByBlock` returns today survives — the review the product is
-- already showing. The superseded duplicates were never reachable.
DELETE FROM "requirement_reviews" a
  USING "requirement_reviews" b
  WHERE a.workspace_id = b.workspace_id
    AND a.block_id = b.block_id
    AND (b.created_at, b.id) > (a.created_at, a.id);
--> statement-breakpoint
DELETE FROM "clarity_reviews" a
  USING "clarity_reviews" b
  WHERE a.workspace_id = b.workspace_id
    AND a.block_id = b.block_id
    AND (b.created_at, b.id) > (a.created_at, a.id);
--> statement-breakpoint
-- Brainstorm is keyed by (block, STAGE): a block legitimately holds one live `requirements` and
-- one live `architecture` session at once, so the stage is part of the uniqueness key.
DELETE FROM "brainstorm_sessions" a
  USING "brainstorm_sessions" b
  WHERE a.workspace_id = b.workspace_id
    AND a.block_id = b.block_id
    AND a.stage = b.stage
    AND (b.created_at, b.id) > (a.created_at, a.id);
--> statement-breakpoint
DROP INDEX "idx_brainstorm_sessions_block_stage";--> statement-breakpoint
CREATE UNIQUE INDEX "idx_brainstorm_sessions_block_stage" ON "brainstorm_sessions" ("workspace_id","block_id","stage");--> statement-breakpoint
DROP INDEX "idx_clarity_reviews_block";--> statement-breakpoint
CREATE UNIQUE INDEX "idx_clarity_reviews_block" ON "clarity_reviews" ("workspace_id","block_id");--> statement-breakpoint
DROP INDEX "idx_requirement_reviews_block";--> statement-breakpoint
CREATE UNIQUE INDEX "idx_requirement_reviews_block" ON "requirement_reviews" ("workspace_id","block_id");
