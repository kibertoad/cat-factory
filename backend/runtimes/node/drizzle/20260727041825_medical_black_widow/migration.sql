CREATE TABLE "review_question_posts" (
	"workspace_id" text,
	"review_id" text,
	"iteration" integer,
	"issue_ref" text,
	"status" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "review_question_posts_pkey" PRIMARY KEY("workspace_id","review_id","iteration","issue_ref")
);
--> statement-breakpoint
ALTER TABLE "blocks" ADD COLUMN "tracker_questions_on_park" text;--> statement-breakpoint
ALTER TABLE "tracker_settings" ADD COLUMN "writeback_questions_on_park" integer DEFAULT 0 NOT NULL;