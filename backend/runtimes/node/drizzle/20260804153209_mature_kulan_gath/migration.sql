CREATE TABLE "telemetry"."agent_tool_calls" (
	"id" text PRIMARY KEY,
	"workspace_id" text NOT NULL,
	"execution_id" text NOT NULL,
	"agent_kind" text NOT NULL,
	"job_id" text NOT NULL,
	"seq" integer NOT NULL,
	"tool" text NOT NULL,
	"started_at" bigint NOT NULL,
	"ended_at" bigint NOT NULL,
	"ok" integer DEFAULT 1 NOT NULL,
	"bodies" text DEFAULT 'withheld' NOT NULL,
	"args" text DEFAULT '' NOT NULL,
	"result" text DEFAULT '' NOT NULL,
	"args_dropped" integer DEFAULT 0 NOT NULL,
	"result_dropped" integer DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_agent_tool_calls_trajectory" ON "telemetry"."agent_tool_calls" ("workspace_id","execution_id","job_id","seq");--> statement-breakpoint
CREATE INDEX "idx_agent_tool_calls_execution" ON "telemetry"."agent_tool_calls" ("workspace_id","execution_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_agent_tool_calls_created" ON "telemetry"."agent_tool_calls" ("created_at");