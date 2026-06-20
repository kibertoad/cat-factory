CREATE TABLE "github_installations" (
	"installation_id" bigint PRIMARY KEY,
	"workspace_id" text NOT NULL,
	"account_id" text,
	"account_login" text NOT NULL,
	"target_type" text NOT NULL,
	"app_id" text,
	"cached_token" text,
	"token_expires_at" bigint,
	"created_at" bigint NOT NULL,
	"deleted_at" bigint
);
--> statement-breakpoint
CREATE TABLE "github_repos" (
	"workspace_id" text,
	"github_id" bigint,
	"installation_id" bigint NOT NULL,
	"owner" text NOT NULL,
	"name" text NOT NULL,
	"default_branch" text,
	"private" integer DEFAULT 0 NOT NULL,
	"block_id" text,
	"etag" text,
	"synced_at" bigint NOT NULL,
	"deleted_at" bigint,
	CONSTRAINT "github_repos_pkey" PRIMARY KEY("workspace_id","github_id")
);
--> statement-breakpoint
CREATE TABLE "runner_pool_connections" (
	"workspace_id" text,
	"provider_id" text,
	"label" text NOT NULL,
	"base_url" text NOT NULL,
	"manifest_json" text NOT NULL,
	"secrets_cipher" text NOT NULL,
	"created_at" bigint NOT NULL,
	"deleted_at" bigint,
	CONSTRAINT "runner_pool_connections_pkey" PRIMARY KEY("workspace_id","provider_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_gh_install_workspace" ON "github_installations" ("workspace_id") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "idx_gh_install_account" ON "github_installations" ("account_id") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "idx_gh_repos_install" ON "github_repos" ("installation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_runner_pool_conn_workspace" ON "runner_pool_connections" ("workspace_id") WHERE deleted_at IS NULL;