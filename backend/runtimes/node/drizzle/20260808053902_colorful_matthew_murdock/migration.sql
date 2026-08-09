CREATE TABLE "notification_settings" (
	"workspace_id" text PRIMARY KEY,
	"matrix" text DEFAULT '{}' NOT NULL,
	"updated_at" bigint NOT NULL
);
