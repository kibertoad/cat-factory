ALTER TABLE "merge_threshold_presets" ADD COLUMN "auto_merge_enabled" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "merge_threshold_presets" ADD COLUMN "version" integer;