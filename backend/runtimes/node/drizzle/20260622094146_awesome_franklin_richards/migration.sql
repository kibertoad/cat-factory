CREATE TABLE "account_invitations" (
	"id" text PRIMARY KEY,
	"account_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"token_hash" text NOT NULL,
	"invited_by" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" bigint NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_connections" (
	"account_id" text PRIMARY KEY,
	"provider" text NOT NULL,
	"from_address" text NOT NULL,
	"api_key_cipher" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"deleted_at" bigint
);
--> statement-breakpoint
CREATE TABLE "user_identities" (
	"user_id" text NOT NULL,
	"provider" text,
	"subject" text,
	"secret" text,
	"metadata" text,
	"created_at" bigint NOT NULL,
	CONSTRAINT "user_identities_pkey" PRIMARY KEY("provider","subject")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY,
	"name" text,
	"email" text,
	"avatar_url" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "owner_user_id" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "blocks" ALTER COLUMN "created_by" SET DATA TYPE text USING "created_by"::text;--> statement-breakpoint
ALTER TABLE "memberships" ALTER COLUMN "user_id" SET DATA TYPE text USING "user_id"::text;--> statement-breakpoint
ALTER TABLE "personal_subscriptions" ALTER COLUMN "user_id" SET DATA TYPE text USING "user_id"::text;--> statement-breakpoint
ALTER TABLE "subscription_activations" ALTER COLUMN "user_id" SET DATA TYPE text USING "user_id"::text;--> statement-breakpoint
ALTER TABLE "workspaces" ALTER COLUMN "owner_user_id" SET DATA TYPE text USING "owner_user_id"::text;--> statement-breakpoint
DROP INDEX "idx_accounts_personal";--> statement-breakpoint
CREATE UNIQUE INDEX "idx_accounts_personal" ON "accounts" ("owner_user_id") WHERE type = 'personal';--> statement-breakpoint
CREATE INDEX "idx_account_invitations_account" ON "account_invitations" ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_account_invitations_token" ON "account_invitations" ("token_hash");--> statement-breakpoint
CREATE INDEX "idx_user_identities_user" ON "user_identities" ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_users_email" ON "users" ("email") WHERE email IS NOT NULL;