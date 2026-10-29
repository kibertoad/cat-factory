CREATE TABLE "refined_requirements_posts" (
	"workspace_id" text,
	"review_id" text,
	"issue_ref" text,
	"document_hash" text,
	"status" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "refined_requirements_posts_pkey" PRIMARY KEY("workspace_id","review_id","issue_ref","document_hash")
);
