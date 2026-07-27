CREATE TABLE "acceptance_criteria" (
	"id" text PRIMARY KEY,
	"workspace_id" text NOT NULL,
	"block_id" text NOT NULL,
	"title" text NOT NULL,
	"given_text" text DEFAULT '' NOT NULL,
	"when_text" text DEFAULT '' NOT NULL,
	"outcome_text" text DEFAULT '' NOT NULL,
	"tags" text DEFAULT '[]' NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"provenance" text DEFAULT 'authored' NOT NULL,
	"source_review_id" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_acceptance_criteria_workspace_block" ON "acceptance_criteria" ("workspace_id","block_id");