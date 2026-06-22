CREATE TABLE "personal_subscriptions" (
	"id" text PRIMARY KEY,
	"user_id" bigint NOT NULL,
	"vendor" text NOT NULL,
	"label" text NOT NULL,
	"token_cipher" text NOT NULL,
	"expires_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"last_used_at" bigint,
	"deleted_at" bigint
);
--> statement-breakpoint
CREATE TABLE "subscription_activations" (
	"id" text PRIMARY KEY,
	"execution_id" text NOT NULL,
	"user_id" bigint NOT NULL,
	"vendor" text NOT NULL,
	"token_cipher" text NOT NULL,
	"created_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_personal_subs_user_vendor" ON "personal_subscriptions" ("user_id","vendor") WHERE "deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_personal_subs_expiry" ON "personal_subscriptions" ("expires_at") WHERE "deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_sub_activations_run" ON "subscription_activations" ("execution_id","user_id","vendor");--> statement-breakpoint
CREATE INDEX "idx_sub_activations_expiry" ON "subscription_activations" ("expires_at");