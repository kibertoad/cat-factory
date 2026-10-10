CREATE TABLE "gate_outcomes" (
	"id" text PRIMARY KEY,
	"workspace_id" text NOT NULL,
	"execution_id" text NOT NULL,
	"block_id" text NOT NULL,
	"gate_kind" text NOT NULL,
	"helper_kind" text,
	"outcome" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 0 NOT NULL,
	"helper_failures" integer DEFAULT 0 NOT NULL,
	"duration_ms" bigint,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_run_days" (
	"workspace_id" text,
	"day_start" bigint,
	"status" text,
	"failure_kind" text DEFAULT '',
	"run_count" integer NOT NULL,
	CONSTRAINT "platform_run_days_pkey" PRIMARY KEY("workspace_id","day_start","status","failure_kind")
);
--> statement-breakpoint
CREATE INDEX "idx_gate_outcomes_workspace_created" ON "gate_outcomes" ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_gate_outcomes_created" ON "gate_outcomes" ("created_at");--> statement-breakpoint
CREATE INDEX "idx_platform_run_days_day" ON "platform_run_days" ("day_start");