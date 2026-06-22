CREATE TABLE "repo_blueprints" (
	"id" text PRIMARY KEY,
	"workspace_id" text NOT NULL,
	"repo_owner" text NOT NULL,
	"repo_name" text NOT NULL,
	"source" text NOT NULL,
	"service_json" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_repo_blueprints_repo" ON "repo_blueprints" ("workspace_id","repo_owner","repo_name");--> statement-breakpoint
CREATE INDEX "idx_repo_blueprints_workspace" ON "repo_blueprints" ("workspace_id","updated_at");
