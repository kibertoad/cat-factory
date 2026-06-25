CREATE SCHEMA IF NOT EXISTS "sandbox";
--> statement-breakpoint
CREATE TABLE "sandbox"."prompt_versions" (
	"workspace_id" text NOT NULL,
	"id" text NOT NULL,
	"lineage_id" text NOT NULL,
	"agent_kind" text NOT NULL,
	"name" text NOT NULL,
	"origin" text NOT NULL,
	"system_text" text NOT NULL,
	"base_prompt_id" text,
	"version" integer NOT NULL,
	"parent_id" text,
	"labels" text DEFAULT '[]' NOT NULL,
	"created_at" bigint NOT NULL,
	"created_by" text,
	"archived_at" bigint,
	CONSTRAINT "prompt_versions_pkey" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "sandbox"."fixtures" (
	"workspace_id" text NOT NULL,
	"id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"payload" text,
	"repo_ref" text,
	"objective" text,
	"origin" text NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "fixtures_pkey" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "sandbox"."experiments" (
	"workspace_id" text NOT NULL,
	"id" text NOT NULL,
	"name" text NOT NULL,
	"agent_kind" text NOT NULL,
	"judge_model" text NOT NULL,
	"repeats" integer NOT NULL,
	"status" text NOT NULL,
	"matrix" text NOT NULL,
	"budget_tokens" bigint,
	"created_at" bigint NOT NULL,
	"created_by" text,
	CONSTRAINT "experiments_pkey" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "sandbox"."runs" (
	"workspace_id" text NOT NULL,
	"id" text NOT NULL,
	"experiment_id" text NOT NULL,
	"prompt_version_id" text NOT NULL,
	"model" text NOT NULL,
	"fixture_id" text NOT NULL,
	"repeat_index" integer NOT NULL,
	"status" text NOT NULL,
	"output_text" text,
	"usage" text,
	"latency_ms" integer,
	"branch" text,
	"pr_url" text,
	"diff" text,
	"error" text,
	"seed_sha" text,
	"prompt_label" text NOT NULL,
	"started_at" bigint,
	"finished_at" bigint,
	CONSTRAINT "runs_pkey" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "sandbox"."grades" (
	"workspace_id" text NOT NULL,
	"id" text NOT NULL,
	"run_id" text NOT NULL,
	"judge_model" text NOT NULL,
	"scores" text DEFAULT '[]' NOT NULL,
	"weighted_total" double precision NOT NULL,
	"objective" text,
	"created_at" bigint NOT NULL,
	CONSTRAINT "grades_pkey" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE INDEX "idx_sandbox_prompts_kind" ON "sandbox"."prompt_versions" USING btree ("workspace_id","agent_kind");
--> statement-breakpoint
CREATE INDEX "idx_sandbox_runs_experiment" ON "sandbox"."runs" USING btree ("workspace_id","experiment_id");
--> statement-breakpoint
CREATE INDEX "idx_sandbox_runs_queued" ON "sandbox"."runs" USING btree ("workspace_id","experiment_id","status");
--> statement-breakpoint
CREATE INDEX "idx_sandbox_grades_run" ON "sandbox"."grades" USING btree ("workspace_id","run_id");
