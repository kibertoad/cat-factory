ALTER TABLE "blocks" ADD COLUMN "epic_id" text;
--> statement-breakpoint
ALTER TABLE "blocks" ADD COLUMN "auto_start_dependents" integer;
--> statement-breakpoint
CREATE INDEX "idx_blocks_epic" ON "blocks" USING btree ("workspace_id","epic_id");
