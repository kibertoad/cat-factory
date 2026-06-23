CREATE TABLE "clarity_reviews" (
	"workspace_id" text,
	"id" text,
	"block_id" text NOT NULL,
	"status" text NOT NULL,
	"items" text DEFAULT '[]' NOT NULL,
	"model" text,
	"clarified_report" text,
	"iteration" integer DEFAULT 1 NOT NULL,
	"max_iterations" integer DEFAULT 1 NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "clarity_reviews_pkey" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE INDEX "idx_clarity_reviews_block" ON "clarity_reviews" ("workspace_id","block_id");