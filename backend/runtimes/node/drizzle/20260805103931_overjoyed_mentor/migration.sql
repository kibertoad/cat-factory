CREATE TABLE "mcp_oauth_grants" (
	"workspace_id" text,
	"server_id" text,
	"tokens" text NOT NULL,
	"summary" text DEFAULT '{}' NOT NULL,
	"rev" integer DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "mcp_oauth_grants_pkey" PRIMARY KEY("workspace_id","server_id")
);
