ALTER TABLE "blocks" ADD COLUMN "completed_at" double precision;--> statement-breakpoint
ALTER TABLE "workspace_settings" ADD COLUMN "done_lane_max_items" integer DEFAULT 20 NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_settings" ADD COLUMN "done_lane_retention_days" integer DEFAULT 14;