CREATE TABLE "writeback_posts" (
	"workspace_id" text,
	"kind" text,
	"subject_id" text,
	"issue_ref" text,
	"discriminator" text,
	"status" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"claim_token" text,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "writeback_posts_pkey" PRIMARY KEY("workspace_id","kind","subject_id","issue_ref","discriminator")
);
--> statement-breakpoint
INSERT INTO "writeback_posts" ("workspace_id", "kind", "subject_id", "issue_ref", "discriminator", "status", "attempts", "error", "claim_token", "updated_at")
SELECT "workspace_id", 'review_questions', "review_id", "issue_ref", "iteration"::text, "status", "attempts", "error", NULL, "updated_at"
FROM "review_question_posts";
--> statement-breakpoint
DROP TABLE "review_question_posts";
