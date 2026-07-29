CREATE TABLE "agent_prompt_revisions" (
	"workspace_id" text,
	"agent_kind" text,
	"revision" integer,
	"text" text,
	"restored_from" integer,
	"created_at" bigint NOT NULL,
	"created_by" text,
	CONSTRAINT "agent_prompt_revisions_pkey" PRIMARY KEY("workspace_id","agent_kind","revision")
);
--> statement-breakpoint
CREATE INDEX "idx_agent_prompt_revisions_workspace" ON "agent_prompt_revisions" ("workspace_id","agent_kind","revision");