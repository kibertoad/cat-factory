ALTER TABLE "pipeline_schedules" ADD COLUMN "service_id" text;--> statement-breakpoint
CREATE INDEX "idx_pipeline_schedules_service" ON "pipeline_schedules" ("service_id");