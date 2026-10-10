ALTER TABLE "binary_artifacts" ADD COLUMN "document_source" text;--> statement-breakpoint
ALTER TABLE "binary_artifacts" ADD COLUMN "document_external_id" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "render_status" text;--> statement-breakpoint
CREATE INDEX "idx_binary_artifacts_document" ON "binary_artifacts" ("workspace_id","document_source","document_external_id");