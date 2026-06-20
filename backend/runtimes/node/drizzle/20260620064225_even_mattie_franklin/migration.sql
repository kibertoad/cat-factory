CREATE TABLE "workspace_model_defaults" (
	"workspace_id" text,
	"agent_kind" text,
	"model_id" text NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "workspace_model_defaults_pkey" PRIMARY KEY("workspace_id","agent_kind")
);
