CREATE TABLE "api_contracts" (
	"owner_kind" text,
	"owner_id" text,
	"service_id" text,
	"contract_id" text,
	"format" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"operations" text DEFAULT '[]' NOT NULL,
	"omitted_operations" integer DEFAULT 0 NOT NULL,
	"source_path" text,
	"source_sha" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "api_contracts_pkey" PRIMARY KEY("owner_kind","owner_id","service_id","contract_id")
);
--> statement-breakpoint
CREATE TABLE "foundational_service_sources" (
	"id" text PRIMARY KEY,
	"owner_kind" text NOT NULL,
	"owner_id" text NOT NULL,
	"repo_owner" text NOT NULL,
	"repo_name" text NOT NULL,
	"git_ref" text DEFAULT 'HEAD' NOT NULL,
	"mode" text DEFAULT 'directory' NOT NULL,
	"dir_path" text DEFAULT '' NOT NULL,
	"file_paths" text DEFAULT '[]' NOT NULL,
	"service_id" text,
	"service_name" text,
	"service_summary" text,
	"last_synced_commit" text,
	"last_synced_at" bigint,
	"last_attempted_at" bigint,
	"last_error" text,
	"created_at" bigint NOT NULL,
	"deleted_at" bigint
);
--> statement-breakpoint
CREATE TABLE "foundational_services" (
	"service_id" text,
	"owner_kind" text,
	"owner_id" text,
	"name" text NOT NULL,
	"summary" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"capabilities" text DEFAULT '[]' NOT NULL,
	"source_id" text,
	"source_path" text,
	"pinned_commit" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"deleted_at" bigint,
	CONSTRAINT "foundational_services_pkey" PRIMARY KEY("owner_kind","owner_id","service_id")
);
--> statement-breakpoint
CREATE INDEX "idx_api_contracts_owner" ON "api_contracts" ("owner_kind","owner_id","service_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_foundational_sources_unique" ON "foundational_service_sources" ("owner_kind","owner_id","repo_owner","repo_name","git_ref","dir_path");--> statement-breakpoint
CREATE INDEX "idx_foundational_sources_owner" ON "foundational_service_sources" ("owner_kind","owner_id") WHERE "deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_foundational_sources_stale" ON "foundational_service_sources" ("last_attempted_at") WHERE "deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_foundational_services_owner" ON "foundational_services" ("owner_kind","owner_id") WHERE "deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_foundational_services_source" ON "foundational_services" ("source_id") WHERE "deleted_at" IS NULL;