CREATE TABLE "doc_interview_sessions" (
	"workspace_id" text,
	"id" text,
	"block_id" text NOT NULL,
	"status" text NOT NULL,
	"round" integer DEFAULT 0 NOT NULL,
	"max_rounds" integer DEFAULT 4 NOT NULL,
	"qa" text DEFAULT '[]' NOT NULL,
	"brief" text,
	"model" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "doc_interview_sessions_pkey" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE INDEX "idx_doc_interview_sessions_block" ON "doc_interview_sessions" ("workspace_id","block_id");