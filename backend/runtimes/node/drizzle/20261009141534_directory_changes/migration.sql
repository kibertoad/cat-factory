CREATE TABLE "directory_changes" (
	"account_id" text,
	"seq" bigint,
	"entity_type" text NOT NULL,
	"workspace_id" text,
	"entity_id" text NOT NULL,
	"at" bigint NOT NULL,
	CONSTRAINT "directory_changes_pkey" PRIMARY KEY("account_id","seq")
);
--> statement-breakpoint
CREATE INDEX "idx_directory_changes_at" ON "directory_changes" ("at");