ALTER TABLE "blocks" ADD COLUMN "expedition_id" text;--> statement-breakpoint
ALTER TABLE "workspace_settings" ADD COLUMN "bug_fishing_fix_pipeline_id" text;--> statement-breakpoint
CREATE INDEX "idx_blocks_expedition" ON "blocks" ("workspace_id","expedition_id");