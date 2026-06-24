ALTER TABLE "blocks" ADD COLUMN "tracker_comment_on_pr_open" text;--> statement-breakpoint
ALTER TABLE "blocks" ADD COLUMN "tracker_resolve_on_merge" text;--> statement-breakpoint
ALTER TABLE "tracker_settings" ADD COLUMN "writeback_comment_on_pr_open" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tracker_settings" ADD COLUMN "writeback_resolve_on_merge" integer DEFAULT 0 NOT NULL;