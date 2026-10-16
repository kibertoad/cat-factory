CREATE TABLE "account_runner_pools" (
	"account_id" text PRIMARY KEY,
	"kind" text NOT NULL,
	"provider_id" text NOT NULL,
	"label" text NOT NULL,
	"base_url" text NOT NULL,
	"config_json" text NOT NULL,
	"secrets_cipher" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_settings" ADD COLUMN "inherit_account_runner_pool" integer DEFAULT 1 NOT NULL;