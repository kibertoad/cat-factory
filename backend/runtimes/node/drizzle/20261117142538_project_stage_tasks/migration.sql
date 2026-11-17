CREATE TABLE "project_stage_tasks" (
	"task_id" text PRIMARY KEY,
	"project_id" text NOT NULL,
	"stage_id" text NOT NULL,
	"created_at" bigint NOT NULL,
	"basis" text NOT NULL,
	"recorded_at" bigint,
	"cleared_at" bigint,
	"cleared_by" text
);
--> statement-breakpoint
CREATE INDEX "idx_project_stage_tasks_project" ON "project_stage_tasks" ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_project_stage_tasks_open" ON "project_stage_tasks" ("project_id","stage_id") WHERE "recorded_at" IS NULL;