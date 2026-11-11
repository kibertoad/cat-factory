CREATE TABLE "outcome_storage_policies" (
	"owner_kind" text,
	"owner_id" text,
	"policy" text NOT NULL,
	CONSTRAINT "outcome_storage_policies_pkey" PRIMARY KEY("owner_kind","owner_id")
);
--> statement-breakpoint
CREATE TABLE "project_definitions" (
	"account_id" text,
	"kind" text,
	"key" text,
	"version" integer,
	"body" text NOT NULL,
	"content_hash" text NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "project_definitions_pkey" PRIMARY KEY("account_id","kind","key","version")
);
--> statement-breakpoint
CREATE TABLE "project_outcome_seqs" (
	"project_id" text PRIMARY KEY,
	"next_seq" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_outcomes" (
	"id" text PRIMARY KEY,
	"project_id" text NOT NULL,
	"stream" text NOT NULL,
	"seq" integer NOT NULL,
	"intent" text NOT NULL,
	"schema_version" integer NOT NULL,
	"task_id" text,
	"definition_key" text,
	"definition_version" integer,
	"artifact_refs" text NOT NULL,
	"created_at" bigint NOT NULL,
	"body_inline" text,
	"body_artifact_id" text,
	"body_bytes" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_pins" (
	"project_id" text PRIMARY KEY,
	"definition_key" text NOT NULL,
	"definition_version" integer NOT NULL,
	"definition_hash" text NOT NULL,
	"inputs" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_project_outcomes_seq" ON "project_outcomes" ("project_id","seq");