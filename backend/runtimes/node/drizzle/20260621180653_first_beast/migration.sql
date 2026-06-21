CREATE TABLE "notifications" (
	"workspace_id" text,
	"id" text,
	"type" text NOT NULL,
	"status" text NOT NULL,
	"block_id" text,
	"execution_id" text,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"payload" text,
	"created_at" bigint NOT NULL,
	"resolved_at" bigint,
	CONSTRAINT "notifications_pkey" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "slack_connections" (
	"account_id" text PRIMARY KEY,
	"team_id" text NOT NULL,
	"team_name" text NOT NULL,
	"team_icon_url" text,
	"bot_user_id" text,
	"scopes" text,
	"token_cipher" text NOT NULL,
	"created_at" bigint NOT NULL,
	"deleted_at" bigint
);
--> statement-breakpoint
CREATE TABLE "slack_member_mappings" (
	"account_id" text PRIMARY KEY,
	"entries" text DEFAULT '[]' NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slack_settings" (
	"workspace_id" text PRIMARY KEY,
	"routes" text DEFAULT '{}' NOT NULL,
	"mentions_enabled" integer DEFAULT 0 NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_notifications_open" ON "notifications" ("workspace_id","status","created_at");--> statement-breakpoint
CREATE INDEX "idx_notifications_block" ON "notifications" ("workspace_id","block_id","type","status");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_slack_conn_team" ON "slack_connections" ("team_id") WHERE deleted_at IS NULL;