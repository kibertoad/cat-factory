CREATE TABLE "merge_threshold_presets" (
	"workspace_id" text,
	"id" text,
	"name" text NOT NULL,
	"max_complexity" double precision NOT NULL,
	"max_risk" double precision NOT NULL,
	"max_impact" double precision NOT NULL,
	"ci_max_attempts" integer NOT NULL,
	"is_default" integer DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "merge_threshold_presets_pkey" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE INDEX "idx_merge_presets_default" ON "merge_threshold_presets" ("workspace_id","is_default");
