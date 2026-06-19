CREATE TABLE "llm_call_metrics" (
	"id" text PRIMARY KEY,
	"workspace_id" text NOT NULL,
	"execution_id" text,
	"agent_kind" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"created_at" bigint NOT NULL,
	"streaming" integer DEFAULT 0 NOT NULL,
	"message_count" integer DEFAULT 0 NOT NULL,
	"tool_count" integer DEFAULT 0 NOT NULL,
	"request_max_tokens" integer,
	"prompt_tokens" integer DEFAULT 0 NOT NULL,
	"completion_tokens" integer DEFAULT 0 NOT NULL,
	"total_tokens" integer DEFAULT 0 NOT NULL,
	"finish_reason" text,
	"upstream_ms" integer DEFAULT 0 NOT NULL,
	"overhead_ms" integer DEFAULT 0 NOT NULL,
	"total_ms" integer DEFAULT 0 NOT NULL,
	"ok" integer DEFAULT 1 NOT NULL,
	"http_status" integer,
	"error_message" text,
	"prompt_text" text DEFAULT '' NOT NULL,
	"response_text" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_llm_call_metrics_execution" ON "llm_call_metrics" ("workspace_id","execution_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_llm_call_metrics_created" ON "llm_call_metrics" ("created_at");