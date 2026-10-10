CREATE TABLE "account_risk_policies" (
	"account_id" text,
	"id" text,
	"name" text NOT NULL,
	"max_complexity" double precision NOT NULL,
	"max_risk" double precision NOT NULL,
	"max_impact" double precision NOT NULL,
	"ci_max_attempts" integer NOT NULL,
	"max_requirement_iterations" integer DEFAULT 3 NOT NULL,
	"max_requirement_concern_allowed" text DEFAULT 'none' NOT NULL,
	"max_tester_quality_iterations" integer DEFAULT 3 NOT NULL,
	"release_watch_window_minutes" integer DEFAULT 30 NOT NULL,
	"release_max_attempts" integer DEFAULT 1 NOT NULL,
	"human_review_grace_minutes" integer DEFAULT 10 NOT NULL,
	"judge_min_score" double precision DEFAULT 0.7 NOT NULL,
	"judge_max_bounces" integer DEFAULT 1 NOT NULL,
	"auto_merge_enabled" integer DEFAULT 1 NOT NULL,
	"fork_decision" text,
	"class_rules" text DEFAULT '{}' NOT NULL,
	"class_rules_by_role" text DEFAULT '{}' NOT NULL,
	"dry_run_roles" text DEFAULT '[]' NOT NULL,
	"submission_classes_by_role" text DEFAULT '{}' NOT NULL,
	"version" integer,
	"autonomy" text DEFAULT 'attended' NOT NULL,
	"min_auto_answer_confidence" double precision DEFAULT 0.8 NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "account_risk_policies_pkey" PRIMARY KEY("account_id","id")
);
--> statement-breakpoint
CREATE TABLE "risk_policy_suppressions" (
	"workspace_id" text,
	"policy_id" text,
	"created_at" bigint NOT NULL,
	CONSTRAINT "risk_policy_suppressions_pkey" PRIMARY KEY("workspace_id","policy_id")
);
