CREATE TABLE "provider_model_catalog" (
	"workspace_id" text,
	"provider" text,
	"models" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "provider_model_catalog_pkey" PRIMARY KEY("workspace_id","provider")
);