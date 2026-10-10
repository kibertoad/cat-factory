ALTER TABLE "kaizen_gradings" ADD COLUMN "acknowledged_at" bigint;--> statement-breakpoint
ALTER TABLE "kaizen_gradings" ADD COLUMN "acknowledged_by" text;--> statement-breakpoint
ALTER TABLE "kaizen_gradings" ADD COLUMN "acknowledgement_note" text;--> statement-breakpoint
CREATE INDEX "idx_kaizen_gradings_workspace_created" ON "kaizen_gradings" ("workspace_id","created_at");