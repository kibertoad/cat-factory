CREATE TABLE "subscription_quota_cycles" (
	"id" text PRIMARY KEY,
	"scope" text NOT NULL,
	"scope_id" text NOT NULL,
	"vendor" text NOT NULL,
	"window_kind" text NOT NULL,
	"window_started_at" bigint NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"request_count" integer DEFAULT 0 NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_subscription_quota_cycles_key" ON "subscription_quota_cycles" ("scope","scope_id","vendor","window_kind");--> statement-breakpoint
CREATE INDEX "idx_subscription_quota_cycles_window" ON "subscription_quota_cycles" ("window_started_at");