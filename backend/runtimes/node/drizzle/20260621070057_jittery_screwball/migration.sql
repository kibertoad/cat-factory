CREATE TABLE "requirement_reviews" (
	"workspace_id" text,
	"id" text,
	"block_id" text NOT NULL,
	"status" text NOT NULL,
	"items" text DEFAULT '[]' NOT NULL,
	"model" text,
	"incorporated_requirements" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "requirement_reviews_pkey" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE INDEX "idx_requirement_reviews_block" ON "requirement_reviews" ("workspace_id","block_id");