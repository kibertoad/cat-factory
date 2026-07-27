CREATE TABLE "notification_webhooks" (
	"workspace_id" text PRIMARY KEY,
	"url" text NOT NULL,
	"types" text DEFAULT '[]' NOT NULL,
	"enabled" integer DEFAULT 1 NOT NULL,
	"secret_sealed" text,
	"updated_at" bigint NOT NULL
);
