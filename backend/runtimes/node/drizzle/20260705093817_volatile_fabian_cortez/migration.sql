ALTER TABLE "documents" ADD COLUMN "role" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "doc_kind" text;--> statement-breakpoint
CREATE INDEX "idx_documents_role" ON "documents" ("workspace_id","role","doc_kind");