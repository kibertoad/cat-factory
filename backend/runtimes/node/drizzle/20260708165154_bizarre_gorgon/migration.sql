ALTER TABLE "token_usage" ADD COLUMN "billing" text DEFAULT 'metered' NOT NULL;--> statement-breakpoint
ALTER TABLE "token_usage" ADD COLUMN "vendor" text;