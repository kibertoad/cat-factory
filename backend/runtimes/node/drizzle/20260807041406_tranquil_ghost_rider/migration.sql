CREATE TABLE "spend_days" (
	"workspace_id" text,
	"day_start" bigint,
	"execution_id" text DEFAULT '',
	"agent_kind" text DEFAULT '',
	"provider" text DEFAULT '',
	"model" text DEFAULT '',
	"billing" text DEFAULT 'metered',
	"vendor" text DEFAULT '',
	"account_id" text DEFAULT '' NOT NULL,
	"workspace_name" text,
	"block_id" text DEFAULT '' NOT NULL,
	"block_title" text,
	"service_id" text DEFAULT '' NOT NULL,
	"service_name" text,
	"repo_id" text DEFAULT '' NOT NULL,
	"repo_name" text,
	"task_type" text DEFAULT '' NOT NULL,
	"ticket_ref" text DEFAULT '' NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"metered_cost" double precision DEFAULT 0 NOT NULL,
	"subscription_cost" double precision DEFAULT 0 NOT NULL,
	CONSTRAINT "spend_days_pkey" PRIMARY KEY("workspace_id","day_start","execution_id","agent_kind","provider","model","billing","vendor")
);
--> statement-breakpoint
CREATE INDEX "idx_spend_days_account" ON "spend_days" ("account_id","day_start");--> statement-breakpoint
CREATE INDEX "idx_spend_days_day" ON "spend_days" ("day_start");--> statement-breakpoint
CREATE INDEX "idx_spend_days_execution" ON "spend_days" ("workspace_id","execution_id");