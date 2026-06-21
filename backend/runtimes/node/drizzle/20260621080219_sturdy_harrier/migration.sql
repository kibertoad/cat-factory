CREATE TABLE "provider_subscription_tokens" (
	"id" text PRIMARY KEY,
	"workspace_id" text NOT NULL,
	"vendor" text NOT NULL,
	"label" text NOT NULL,
	"token_cipher" text NOT NULL,
	"created_at" bigint NOT NULL,
	"last_used_at" bigint,
	"window_started_at" bigint,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"request_count" integer DEFAULT 0 NOT NULL,
	"deleted_at" bigint
);
--> statement-breakpoint
CREATE INDEX "idx_provider_subs_pool" ON "provider_subscription_tokens" ("workspace_id","vendor","deleted_at");