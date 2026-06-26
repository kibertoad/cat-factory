CREATE SCHEMA "telemetry";
--> statement-breakpoint
ALTER TABLE "llm_call_metrics" SET SCHEMA "telemetry";
--> statement-breakpoint
CREATE TABLE "telemetry"."agent_context_snapshots" (
	"id" text PRIMARY KEY,
	"workspace_id" text NOT NULL,
	"execution_id" text NOT NULL,
	"agent_kind" text NOT NULL,
	"step_index" integer NOT NULL,
	"created_at" bigint NOT NULL,
	"model" text,
	"harness" text,
	"system_prompt" text DEFAULT '' NOT NULL,
	"user_prompt" text DEFAULT '' NOT NULL,
	"fragments" text DEFAULT '[]' NOT NULL,
	"context_files" text DEFAULT '[]' NOT NULL,
	"extras" text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_settings" ADD COLUMN "store_agent_context" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
CREATE INDEX "idx_agent_context_snapshots_execution" ON "telemetry"."agent_context_snapshots" ("workspace_id","execution_id","created_at");
--> statement-breakpoint
CREATE INDEX "idx_agent_context_snapshots_created" ON "telemetry"."agent_context_snapshots" ("created_at");
