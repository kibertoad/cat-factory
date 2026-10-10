CREATE TABLE "guided_review_comment_drafts" (
	"workspace_id" text,
	"id" text,
	"session_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"message_id" text NOT NULL,
	"path" text NOT NULL,
	"line" integer NOT NULL,
	"start_line" integer,
	"side" text NOT NULL,
	"body" text NOT NULL,
	"rationale" text NOT NULL,
	"status" text NOT NULL,
	"post_error" text,
	"posted_url" text,
	"rev" integer NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "guided_review_comment_drafts_pkey" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "guided_review_messages" (
	"workspace_id" text,
	"id" text,
	"thread_id" text NOT NULL,
	"session_id" text NOT NULL,
	"seq" integer NOT NULL,
	"role" text NOT NULL,
	"kind" text NOT NULL,
	"depth" text NOT NULL,
	"content" text NOT NULL,
	"status" text NOT NULL,
	"citations" text DEFAULT '[]' NOT NULL,
	"failure" text,
	"draft_report" text,
	"model" text,
	"claimed_at" bigint,
	"driver" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "guided_review_messages_pkey" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "guided_review_sessions" (
	"workspace_id" text,
	"id" text,
	"provider" text NOT NULL,
	"repo_id" text NOT NULL,
	"owner" text NOT NULL,
	"repo" text NOT NULL,
	"pr_number" integer NOT NULL,
	"pr_title" text NOT NULL,
	"reviewed_head_sha" text NOT NULL,
	"base_ref" text NOT NULL,
	"created_by" text NOT NULL,
	"overview_status" text NOT NULL,
	"overview_generation" integer NOT NULL,
	"overview_content" text,
	"overview_failure" text,
	"overview_model" text,
	"overview_claimed_at" bigint,
	"overview_driver" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "guided_review_sessions_pkey" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "guided_review_threads" (
	"workspace_id" text,
	"id" text,
	"session_id" text NOT NULL,
	"title" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "guided_review_threads_pkey" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE INDEX "idx_guided_review_comment_drafts_session" ON "guided_review_comment_drafts" ("workspace_id","session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_guided_review_messages_seq" ON "guided_review_messages" ("workspace_id","thread_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_guided_review_messages_live" ON "guided_review_messages" ("workspace_id","thread_id") WHERE "role" = 'assistant' AND "status" IN ('pending', 'running');--> statement-breakpoint
CREATE INDEX "idx_guided_review_messages_stale" ON "guided_review_messages" ("driver","status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_guided_review_sessions_pr" ON "guided_review_sessions" ("workspace_id","repo_id","pr_number","created_by");--> statement-breakpoint
CREATE INDEX "idx_guided_review_sessions_stale" ON "guided_review_sessions" ("overview_driver","overview_status","updated_at");--> statement-breakpoint
CREATE INDEX "idx_guided_review_threads_session" ON "guided_review_threads" ("workspace_id","session_id");