CREATE TABLE "pipeline_schedule_runs" (
	"workspace_id" text,
	"id" text,
	"schedule_id" text NOT NULL,
	"execution_id" text,
	"status" text NOT NULL,
	"started_at" bigint NOT NULL,
	"finished_at" bigint,
	"outcome" text,
	CONSTRAINT "pipeline_schedule_runs_pkey" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "pipeline_schedules" (
	"workspace_id" text,
	"id" text,
	"block_id" text NOT NULL,
	"frame_id" text NOT NULL,
	"pipeline_id" text NOT NULL,
	"template" text NOT NULL,
	"name" text NOT NULL,
	"interval_hours" integer NOT NULL,
	"weekdays" text DEFAULT '[]' NOT NULL,
	"window_start_hour" integer,
	"window_end_hour" integer,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"enabled" integer DEFAULT 1 NOT NULL,
	"last_run_at" bigint,
	"next_run_at" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "pipeline_schedules_pkey" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "task_connections" (
	"workspace_id" text,
	"source" text,
	"credentials" text NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"created_at" bigint NOT NULL,
	"deleted_at" bigint,
	CONSTRAINT "task_connections_pkey" PRIMARY KEY("workspace_id","source")
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"workspace_id" text,
	"source" text,
	"external_id" text,
	"title" text NOT NULL,
	"url" text NOT NULL,
	"status" text DEFAULT '' NOT NULL,
	"type" text DEFAULT '' NOT NULL,
	"assignee" text,
	"priority" text,
	"labels" text DEFAULT '[]' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"comments" text DEFAULT '[]' NOT NULL,
	"excerpt" text DEFAULT '' NOT NULL,
	"linked_block_id" text,
	"synced_at" bigint NOT NULL,
	"deleted_at" bigint,
	CONSTRAINT "tasks_pkey" PRIMARY KEY("workspace_id","source","external_id")
);
--> statement-breakpoint
CREATE TABLE "tracker_settings" (
	"workspace_id" text PRIMARY KEY,
	"tracker" text,
	"jira_project_key" text,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_schedule_runs_schedule" ON "pipeline_schedule_runs" ("workspace_id","schedule_id","started_at");--> statement-breakpoint
CREATE INDEX "idx_schedule_runs_started" ON "pipeline_schedule_runs" ("started_at");--> statement-breakpoint
CREATE INDEX "idx_pipeline_schedules_due" ON "pipeline_schedules" ("enabled","next_run_at");--> statement-breakpoint
CREATE INDEX "idx_pipeline_schedules_block" ON "pipeline_schedules" ("workspace_id","block_id");--> statement-breakpoint
CREATE INDEX "idx_tasks_block" ON "tasks" ("workspace_id","linked_block_id");