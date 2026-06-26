CREATE TABLE "brainstorm_sessions" (
	"workspace_id" text,
	"id" text,
	"block_id" text NOT NULL,
	"stage" text NOT NULL,
	"status" text NOT NULL,
	"items" text DEFAULT '[]' NOT NULL,
	"model" text,
	"converged_direction" text,
	"iteration" integer DEFAULT 1 NOT NULL,
	"max_iterations" integer DEFAULT 1 NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "brainstorm_sessions_pkey" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE INDEX "idx_brainstorm_sessions_block_stage" ON "brainstorm_sessions" ("workspace_id","block_id","stage");