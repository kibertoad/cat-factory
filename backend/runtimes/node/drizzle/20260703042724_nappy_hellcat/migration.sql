CREATE TABLE "initiatives" (
	"workspace_id" text,
	"id" text,
	"block_id" text NOT NULL,
	"slug" text NOT NULL,
	"status" text NOT NULL,
	"rev" integer NOT NULL,
	"doc" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "initiatives_pkey" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
ALTER TABLE "blocks" ADD COLUMN "initiative_id" text;--> statement-breakpoint
CREATE INDEX "idx_blocks_initiative" ON "blocks" ("workspace_id","initiative_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_initiatives_block" ON "initiatives" ("workspace_id","block_id");--> statement-breakpoint
CREATE INDEX "idx_initiatives_status" ON "initiatives" ("status");