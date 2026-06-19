CREATE TABLE "accounts" (
	"id" text PRIMARY KEY,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"github_account_login" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"workspace_id" text,
	"id" text,
	"kind" text NOT NULL,
	"block_id" text,
	"status" text NOT NULL,
	"detail" text DEFAULT '{}' NOT NULL,
	"subtasks" text,
	"error" text,
	"failure" text,
	"workflow_instance_id" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "agent_runs_pkey" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "blocks" (
	"workspace_id" text,
	"id" text,
	"title" text NOT NULL,
	"type" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"pos_x" double precision DEFAULT 0 NOT NULL,
	"pos_y" double precision DEFAULT 0 NOT NULL,
	"status" text NOT NULL,
	"progress" double precision DEFAULT 0 NOT NULL,
	"depends_on" text DEFAULT '[]' NOT NULL,
	"execution_id" text,
	"level" text DEFAULT 'frame' NOT NULL,
	"parent_id" text,
	"confidence" double precision,
	"module_name" text,
	"fragment_ids" text,
	"model_id" text,
	"test_target" text,
	"pull_request" text,
	"merge_preset_id" text,
	"pipeline_id" text,
	CONSTRAINT "blocks_pkey" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"account_id" text,
	"user_id" bigint,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "memberships_pkey" PRIMARY KEY("account_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "pipelines" (
	"workspace_id" text,
	"id" text,
	"name" text NOT NULL,
	"agent_kinds" text DEFAULT '[]' NOT NULL,
	"gates" text,
	CONSTRAINT "pipelines_pkey" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "token_usage" (
	"id" text PRIMARY KEY,
	"workspace_id" text NOT NULL,
	"execution_id" text,
	"agent_kind" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_estimate" double precision DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"created_at" bigint NOT NULL,
	"account_id" text,
	"owner_user_id" bigint
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_accounts_personal" ON "accounts" ("github_account_login") WHERE type = 'personal';--> statement-breakpoint
CREATE INDEX "idx_agent_runs_workspace" ON "agent_runs" ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_agent_runs_status_lease" ON "agent_runs" ("status","updated_at");--> statement-breakpoint
CREATE INDEX "idx_agent_runs_block" ON "agent_runs" ("workspace_id","block_id");--> statement-breakpoint
CREATE INDEX "idx_blocks_parent" ON "blocks" ("workspace_id","parent_id");--> statement-breakpoint
CREATE INDEX "idx_memberships_user" ON "memberships" ("user_id");--> statement-breakpoint
CREATE INDEX "idx_token_usage_created" ON "token_usage" ("created_at");--> statement-breakpoint
CREATE INDEX "idx_workspaces_owner" ON "workspaces" ("owner_user_id");--> statement-breakpoint
CREATE INDEX "idx_workspaces_account" ON "workspaces" ("account_id");