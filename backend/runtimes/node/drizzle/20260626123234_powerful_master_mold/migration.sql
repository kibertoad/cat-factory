CREATE TABLE "kaizen_gradings" (
	"workspace_id" text,
	"id" text,
	"execution_id" text NOT NULL,
	"block_id" text NOT NULL,
	"step_index" integer NOT NULL,
	"agent_kind" text NOT NULL,
	"model" text NOT NULL,
	"prompt_version" integer NOT NULL,
	"combo_key" text NOT NULL,
	"status" text NOT NULL,
	"grade" integer,
	"summary" text DEFAULT '' NOT NULL,
	"recommendations" text DEFAULT '[]' NOT NULL,
	"grader_model" text,
	"error" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "kaizen_gradings_pkey" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "kaizen_verified_combos" (
	"workspace_id" text,
	"combo_key" text,
	"agent_kind" text NOT NULL,
	"model" text NOT NULL,
	"prompt_version" integer NOT NULL,
	"consecutive_high_grades" integer DEFAULT 0 NOT NULL,
	"verified" integer DEFAULT 0 NOT NULL,
	"verified_at" bigint,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "kaizen_verified_combos_pkey" PRIMARY KEY("workspace_id","combo_key")
);
--> statement-breakpoint
ALTER TABLE "workspace_settings" ADD COLUMN "kaizen_enabled" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_kaizen_gradings_step" ON "kaizen_gradings" ("workspace_id","execution_id","step_index");--> statement-breakpoint
CREATE INDEX "idx_kaizen_gradings_status" ON "kaizen_gradings" ("status","updated_at");--> statement-breakpoint
CREATE INDEX "idx_kaizen_gradings_execution" ON "kaizen_gradings" ("workspace_id","execution_id");