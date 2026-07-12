CREATE TABLE "environment_test_runs" (
	"id" text PRIMARY KEY,
	"workspace_id" text NOT NULL,
	"block_id" text NOT NULL,
	"status" text NOT NULL,
	"stage" text NOT NULL,
	"initiated_by" text,
	"branch" text,
	"environment_id" text,
	"env_url" text,
	"error" text,
	"failed_stage" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_environment_test_runs_ws_status" ON "environment_test_runs" ("workspace_id","status");