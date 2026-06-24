CREATE TABLE "workspace_settings" (
	"workspace_id" text PRIMARY KEY,
	"waiting_escalation_minutes" integer DEFAULT 120 NOT NULL,
	"task_limit_mode" text DEFAULT 'off' NOT NULL,
	"task_limit_shared" integer,
	"task_limit_per_type" text
);
--> statement-breakpoint
ALTER TABLE "blocks" ADD COLUMN "task_type" text;--> statement-breakpoint
ALTER TABLE "blocks" ADD COLUMN "task_type_fields" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "severity" text;