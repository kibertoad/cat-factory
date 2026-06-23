CREATE TABLE "datadog_connections" (
	"workspace_id" text PRIMARY KEY,
	"site" text NOT NULL,
	"api_key" text NOT NULL,
	"app_key" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "release_health_configs" (
	"workspace_id" text,
	"block_id" text,
	"monitor_ids" text DEFAULT '[]' NOT NULL,
	"slo_ids" text DEFAULT '[]' NOT NULL,
	"env_tag" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "release_health_configs_pkey" PRIMARY KEY("workspace_id","block_id")
);
--> statement-breakpoint
ALTER TABLE "merge_threshold_presets" ADD COLUMN "release_watch_window_minutes" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "merge_threshold_presets" ADD COLUMN "release_max_attempts" integer DEFAULT 1 NOT NULL;