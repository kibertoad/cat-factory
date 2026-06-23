CREATE TABLE "local_model_endpoints" (
	"user_id" text,
	"provider" text,
	"label" text NOT NULL,
	"base_url" text NOT NULL,
	"api_key_cipher" text,
	"models" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "local_model_endpoints_pkey" PRIMARY KEY("user_id","provider")
);
