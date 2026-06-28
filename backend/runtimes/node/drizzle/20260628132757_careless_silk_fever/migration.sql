CREATE TABLE "user_document_connections" (
	"user_id" text,
	"source" text,
	"credentials" text NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"created_at" bigint NOT NULL,
	"deleted_at" bigint,
	CONSTRAINT "user_document_connections_pkey" PRIMARY KEY("user_id","source")
);
