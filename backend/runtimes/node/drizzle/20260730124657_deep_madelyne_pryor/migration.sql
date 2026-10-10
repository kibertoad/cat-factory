CREATE TABLE "workspace_agent_settings" (
	"workspace_id" text,
	"agent_kind" text,
	"max_output_tokens" integer,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "workspace_agent_settings_pkey" PRIMARY KEY("workspace_id","agent_kind")
);
