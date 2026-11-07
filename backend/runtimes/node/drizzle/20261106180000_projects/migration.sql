CREATE TABLE "project_service_links" (
	"project_id" text,
	"service_id" text,
	"position" integer NOT NULL,
	CONSTRAINT "project_service_links_pkey" PRIMARY KEY("project_id","service_id")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY,
	"account_id" text,
	"kind" text NOT NULL,
	"root_block_id" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_mounts" ADD COLUMN "subject_kind" text DEFAULT 'service' NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_project_service_links_service" ON "project_service_links" ("service_id");--> statement-breakpoint
CREATE INDEX "idx_projects_account" ON "projects" ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_projects_root" ON "projects" ("account_id","root_block_id");--> statement-breakpoint
CREATE INDEX "idx_projects_root_block" ON "projects" ("root_block_id");