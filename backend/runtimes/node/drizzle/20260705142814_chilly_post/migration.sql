CREATE TABLE "telemetry"."agent_search_queries" (
	"id" text PRIMARY KEY,
	"workspace_id" text NOT NULL,
	"execution_id" text NOT NULL,
	"agent_kind" text NOT NULL,
	"provider" text,
	"query" text DEFAULT '' NOT NULL,
	"result_count" integer DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_agent_search_queries_execution" ON "telemetry"."agent_search_queries" ("workspace_id","execution_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_agent_search_queries_created" ON "telemetry"."agent_search_queries" ("created_at");