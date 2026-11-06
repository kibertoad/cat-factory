CREATE TABLE "findings_revisions" (
	"id" text PRIMARY KEY,
	"project_id" text NOT NULL,
	"task_id" text NOT NULL,
	"seq" integer NOT NULL,
	"mode" text NOT NULL,
	"definition_key" text NOT NULL,
	"definition_version" integer NOT NULL,
	"created_at" bigint NOT NULL,
	"body_inline" text,
	"body_artifact_id" text,
	"body_bytes" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "findings_storage_policies" (
	"owner_kind" text,
	"owner_id" text,
	"policy" text NOT NULL,
	CONSTRAINT "findings_storage_policies_pkey" PRIMARY KEY("owner_kind","owner_id")
);
--> statement-breakpoint
CREATE TABLE "research_definitions" (
	"account_id" text,
	"key" text,
	"version" integer,
	"body" text NOT NULL,
	"content_hash" text NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "research_definitions_pkey" PRIMARY KEY("account_id","key","version")
);
--> statement-breakpoint
CREATE TABLE "research_projects" (
	"project_id" text PRIMARY KEY,
	"definition_key" text NOT NULL,
	"definition_version" integer NOT NULL,
	"definition_hash" text NOT NULL,
	"inputs" text NOT NULL,
	"next_seq" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_findings_revisions_seq" ON "findings_revisions" ("project_id","seq");