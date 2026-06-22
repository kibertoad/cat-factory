CREATE TABLE "document_connections" (
	"workspace_id" text,
	"source" text,
	"credentials" text NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"created_at" bigint NOT NULL,
	"deleted_at" bigint,
	CONSTRAINT "document_connections_pkey" PRIMARY KEY("workspace_id","source")
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"workspace_id" text,
	"source" text,
	"external_id" text,
	"title" text NOT NULL,
	"url" text NOT NULL,
	"excerpt" text DEFAULT '' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"linked_block_id" text,
	"synced_at" bigint NOT NULL,
	"deleted_at" bigint,
	CONSTRAINT "documents_pkey" PRIMARY KEY("workspace_id","source","external_id")
);
--> statement-breakpoint
CREATE INDEX "idx_documents_block" ON "documents" ("workspace_id","linked_block_id");
