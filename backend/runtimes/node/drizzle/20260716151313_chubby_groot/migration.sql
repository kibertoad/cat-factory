CREATE TABLE "account_skills" (
	"skill_id" text,
	"account_id" text,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"instructions" text NOT NULL,
	"resources" text DEFAULT '[]' NOT NULL,
	"source_id" text NOT NULL,
	"source_path" text NOT NULL,
	"source_sha" text NOT NULL,
	"pinned_commit" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"deleted_at" bigint,
	CONSTRAINT "account_skills_pkey" PRIMARY KEY("account_id","skill_id")
);
--> statement-breakpoint
CREATE TABLE "skill_sources" (
	"id" text PRIMARY KEY,
	"account_id" text NOT NULL,
	"repo_owner" text NOT NULL,
	"repo_name" text NOT NULL,
	"git_ref" text DEFAULT 'HEAD' NOT NULL,
	"dir_path" text DEFAULT '' NOT NULL,
	"last_synced_commit" text,
	"last_synced_at" bigint,
	"created_at" bigint NOT NULL,
	"deleted_at" bigint
);
--> statement-breakpoint
CREATE INDEX "idx_account_skills_account" ON "account_skills" ("account_id") WHERE "deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_account_skills_source" ON "account_skills" ("source_id") WHERE "deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_skill_sources_unique" ON "skill_sources" ("account_id","repo_owner","repo_name","git_ref","dir_path");--> statement-breakpoint
CREATE INDEX "idx_skill_sources_account" ON "skill_sources" ("account_id") WHERE "deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_skill_sources_repo" ON "skill_sources" ("repo_owner","repo_name") WHERE "deleted_at" IS NULL;