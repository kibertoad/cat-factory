CREATE TABLE "environment_connections" (
	"workspace_id" text,
	"provider_id" text,
	"label" text NOT NULL,
	"base_url" text NOT NULL,
	"manifest_json" text NOT NULL,
	"secrets_cipher" text NOT NULL,
	"created_at" bigint NOT NULL,
	"deleted_at" bigint,
	CONSTRAINT "environment_connections_pkey" PRIMARY KEY("workspace_id","provider_id")
);
--> statement-breakpoint
CREATE TABLE "environments" (
	"id" text PRIMARY KEY,
	"workspace_id" text NOT NULL,
	"block_id" text,
	"execution_id" text,
	"provider_id" text NOT NULL,
	"external_id" text,
	"url" text,
	"status" text NOT NULL,
	"access_cipher" text,
	"provision_fields_cipher" text,
	"created_at" bigint NOT NULL,
	"expires_at" bigint,
	"last_error" text,
	"deleted_at" bigint
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_environment_conn_workspace" ON "environment_connections" ("workspace_id") WHERE "deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_environments_block" ON "environments" ("workspace_id","block_id") WHERE "deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_environments_expiry" ON "environments" ("expires_at") WHERE "deleted_at" IS NULL AND "expires_at" IS NOT NULL;
