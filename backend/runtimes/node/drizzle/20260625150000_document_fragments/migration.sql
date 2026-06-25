ALTER TABLE "prompt_fragments" ADD COLUMN "doc_source" text;
--> statement-breakpoint
ALTER TABLE "prompt_fragments" ADD COLUMN "doc_external_id" text;
--> statement-breakpoint
ALTER TABLE "prompt_fragments" ADD COLUMN "doc_via_workspace_id" text;
--> statement-breakpoint
ALTER TABLE "prompt_fragments" ADD COLUMN "resolved_at" bigint;
