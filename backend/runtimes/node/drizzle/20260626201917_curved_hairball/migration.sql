CREATE TABLE "password_reset_tokens" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" bigint NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_password_reset_tokens_token" ON "password_reset_tokens" ("token_hash");--> statement-breakpoint
CREATE INDEX "idx_password_reset_tokens_user" ON "password_reset_tokens" ("user_id","status");