ALTER TABLE "pipelines" ADD COLUMN "is_default" integer;--> statement-breakpoint
ALTER TABLE "pipelines" ADD COLUMN "is_unattended_default" integer;--> statement-breakpoint
ALTER TABLE "merge_threshold_presets" ADD COLUMN "min_auto_answer_confidence" double precision DEFAULT 0.8 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_pipelines_default" ON "pipelines" ("workspace_id") WHERE "is_default" = 1;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_pipelines_unattended_default" ON "pipelines" ("workspace_id") WHERE "is_unattended_default" = 1;