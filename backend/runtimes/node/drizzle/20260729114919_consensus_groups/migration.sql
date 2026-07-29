CREATE TABLE "consensus_groups" (
	"workspace_id" text,
	"id" text,
	"name" text NOT NULL,
	"description" text,
	"strategy" text NOT NULL,
	"participants" text DEFAULT '[]' NOT NULL,
	"synthesizer_model_id" text,
	"rounds" integer,
	"gating" text NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "consensus_groups_pkey" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
ALTER TABLE "consensus_sessions" ADD COLUMN "group_id" text;--> statement-breakpoint
ALTER TABLE "consensus_sessions" ADD COLUMN "group_name" text;--> statement-breakpoint
CREATE INDEX "idx_consensus_groups_workspace" ON "consensus_groups" ("workspace_id","created_at");