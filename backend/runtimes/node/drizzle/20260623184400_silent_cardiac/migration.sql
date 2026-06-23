CREATE TABLE "consensus_sessions" (
	"workspace_id" text,
	"id" text,
	"block_id" text NOT NULL,
	"execution_id" text,
	"step_index" integer NOT NULL,
	"agent_kind" text NOT NULL,
	"strategy" text NOT NULL,
	"status" text NOT NULL,
	"participants" text DEFAULT '[]' NOT NULL,
	"rounds" text DEFAULT '[]' NOT NULL,
	"synthesis" text,
	"confidence" double precision,
	"dissent" text DEFAULT '[]' NOT NULL,
	"error" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "consensus_sessions_pkey" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
ALTER TABLE "blocks" ADD COLUMN "estimate" text;--> statement-breakpoint
ALTER TABLE "pipelines" ADD COLUMN "consensus" text;--> statement-breakpoint
CREATE INDEX "idx_consensus_sessions_step" ON "consensus_sessions" ("workspace_id","execution_id","step_index");--> statement-breakpoint
CREATE INDEX "idx_consensus_sessions_block" ON "consensus_sessions" ("workspace_id","block_id","created_at");