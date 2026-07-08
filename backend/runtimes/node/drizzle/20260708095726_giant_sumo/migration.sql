CREATE TABLE "test_secrets" (
	"workspace_id" text,
	"block_id" text,
	"credentials" text NOT NULL,
	"summary" text DEFAULT '[]' NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "test_secrets_pkey" PRIMARY KEY("workspace_id","block_id")
);
