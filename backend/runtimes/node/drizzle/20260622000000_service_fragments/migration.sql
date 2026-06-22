ALTER TABLE "blocks" ADD COLUMN "service_fragment_ids" text;--> statement-breakpoint
CREATE TABLE "workspace_fragment_defaults" (
	"workspace_id" text PRIMARY KEY,
	"fragment_ids" text NOT NULL,
	"updated_at" bigint NOT NULL
);
