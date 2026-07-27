CREATE TABLE "merge_track_records" (
	"workspace_id" text,
	"id" text,
	"block_id" text NOT NULL,
	"execution_id" text,
	"change_class" text NOT NULL,
	"changed_file_count" integer,
	"complexity" double precision,
	"risk" double precision,
	"impact" double precision,
	"risk_policy_id" text,
	"risk_policy_name" text,
	"decision" text NOT NULL,
	"review_effort" text,
	"pr_number" integer,
	"pr_url" text,
	"repo_id" text,
	"provider" text,
	"created_at" bigint NOT NULL,
	"resolved_at" bigint,
	"tagged_at" bigint,
	CONSTRAINT "merge_track_records_pkey" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
ALTER TABLE "merge_threshold_presets" ADD COLUMN "class_rules" text DEFAULT '{}' NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_merge_track_records_class" ON "merge_track_records" ("workspace_id","change_class");--> statement-breakpoint
CREATE INDEX "idx_merge_track_records_execution" ON "merge_track_records" ("workspace_id","execution_id");--> statement-breakpoint
CREATE INDEX "idx_merge_track_records_block" ON "merge_track_records" ("workspace_id","block_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_merge_track_records_pr" ON "merge_track_records" ("workspace_id","repo_id","pr_number");