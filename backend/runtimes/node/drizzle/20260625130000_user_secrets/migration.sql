CREATE TABLE "user_secrets" (
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"secret_cipher" text NOT NULL,
	"metadata_json" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "user_secrets_pkey" PRIMARY KEY("user_id","kind")
);
