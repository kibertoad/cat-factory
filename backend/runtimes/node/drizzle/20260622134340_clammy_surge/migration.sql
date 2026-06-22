ALTER TABLE "account_invitations" ADD COLUMN "roles" text DEFAULT 'developer' NOT NULL;--> statement-breakpoint
ALTER TABLE "blocks" ADD COLUMN "responsible_product_user_id" text;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "roles" text DEFAULT 'developer' NOT NULL;