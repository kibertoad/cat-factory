CREATE TABLE "validation_configs" (
	"workspace_id" text,
	"block_id" text,
	"checks" text DEFAULT '[]' NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "validation_configs_pkey" PRIMARY KEY("workspace_id","block_id")
);
