CREATE TABLE "service_catalog_connections" (
	"workspace_id" text PRIMARY KEY,
	"provider" text NOT NULL,
	"base_url" text NOT NULL,
	"auth_mode" text NOT NULL,
	"credentials" text DEFAULT '' NOT NULL,
	"entity_filter" text DEFAULT '["kind=component"]' NOT NULL,
	"include_apis" boolean DEFAULT true NOT NULL,
	"max_services" integer DEFAULT 200 NOT NULL,
	"last_synced_at" bigint,
	"last_sync_status" text,
	"last_sync_message" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"deleted_at" bigint
);
--> statement-breakpoint
CREATE INDEX "idx_service_catalog_stale" ON "service_catalog_connections" ("last_synced_at") WHERE "deleted_at" IS NULL;