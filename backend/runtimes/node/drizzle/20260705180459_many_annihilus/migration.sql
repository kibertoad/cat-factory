CREATE TABLE "user_settings" (
	"user_id" text PRIMARY KEY,
	"spend_monthly_limit" double precision,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "spend_monthly_limit" double precision;--> statement-breakpoint
ALTER TABLE "token_usage" ADD COLUMN "account_id" text;--> statement-breakpoint
ALTER TABLE "token_usage" ADD COLUMN "user_id" text;--> statement-breakpoint
CREATE INDEX "idx_token_usage_account" ON "token_usage" ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_token_usage_user" ON "token_usage" ("user_id","created_at");