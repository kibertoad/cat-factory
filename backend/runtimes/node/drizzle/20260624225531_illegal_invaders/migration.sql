CREATE TABLE "model_presets" (
	"workspace_id" text,
	"id" text,
	"name" text NOT NULL,
	"base_model_id" text NOT NULL,
	"overrides" text DEFAULT '{}' NOT NULL,
	"is_default" integer DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "model_presets_pkey" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
ALTER TABLE "blocks" ADD COLUMN "model_preset_id" text;--> statement-breakpoint
CREATE INDEX "idx_model_presets_default" ON "model_presets" ("workspace_id","is_default");