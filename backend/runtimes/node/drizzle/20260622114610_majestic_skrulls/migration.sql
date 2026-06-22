CREATE TABLE "provider_api_keys" (
	"id" text PRIMARY KEY,
	"scope" text NOT NULL,
	"scope_id" text NOT NULL,
	"provider" text NOT NULL,
	"label" text NOT NULL,
	"key_cipher" text NOT NULL,
	"created_at" bigint NOT NULL,
	"last_used_at" bigint,
	"window_started_at" bigint,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"request_count" integer DEFAULT 0 NOT NULL,
	"deleted_at" bigint
);
--> statement-breakpoint
CREATE INDEX "idx_provider_api_keys_pool" ON "provider_api_keys" ("scope","scope_id","provider","deleted_at");