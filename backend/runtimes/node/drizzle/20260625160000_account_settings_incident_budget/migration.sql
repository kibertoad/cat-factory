ALTER TABLE "workspace_settings" ADD COLUMN "spend_currency" text;
--> statement-breakpoint
ALTER TABLE "workspace_settings" ADD COLUMN "spend_monthly_limit" double precision;
--> statement-breakpoint
ALTER TABLE "workspace_settings" ADD COLUMN "spend_model_prices" text;
--> statement-breakpoint
CREATE TABLE "incident_enrichment_connections" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"credentials" text NOT NULL,
	"summary" text DEFAULT '{}' NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account_settings" (
	"account_id" text PRIMARY KEY NOT NULL,
	"config" text NOT NULL,
	"secrets_cipher" text,
	"summary" text DEFAULT '{}' NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
