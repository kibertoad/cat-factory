CREATE TABLE "custom_manifest_types" (
	"workspace_id" text,
	"manifest_id" text,
	"label" text NOT NULL,
	"accepts_input_hint" text,
	"description" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "custom_manifest_types_pkey" PRIMARY KEY("workspace_id","manifest_id")
);
--> statement-breakpoint
CREATE TABLE "environment_user_handlers" (
	"user_id" text,
	"workspace_id" text,
	"provision_type" text,
	"manifest_id" text DEFAULT '',
	"engine" text NOT NULL,
	"provider_id" text NOT NULL,
	"label" text NOT NULL,
	"base_url" text NOT NULL,
	"handler_json" text NOT NULL,
	"accepts_manifest_id" text,
	"secrets_cipher" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "environment_user_handlers_pkey" PRIMARY KEY("user_id","workspace_id","provision_type","manifest_id")
);
--> statement-breakpoint
ALTER TABLE "environments" ADD COLUMN "provision_type" text;--> statement-breakpoint
ALTER TABLE "environments" ADD COLUMN "engine" text;