ALTER TABLE "workspace_settings" ADD COLUMN "review_friction_mode" text DEFAULT 'off' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_settings" ADD COLUMN "review_friction_warn_count" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_settings" ADD COLUMN "review_friction_block_count" integer;--> statement-breakpoint
ALTER TABLE "workspace_settings" ADD COLUMN "review_friction_block_stuck_minutes" integer;