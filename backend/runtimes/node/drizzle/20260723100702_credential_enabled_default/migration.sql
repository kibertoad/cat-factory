ALTER TABLE "provider_api_keys" ADD COLUMN "enabled" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_api_keys" ADD COLUMN "is_default" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_subscription_tokens" ADD COLUMN "enabled" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_subscription_tokens" ADD COLUMN "is_default" integer DEFAULT 0 NOT NULL;