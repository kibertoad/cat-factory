CREATE TABLE "binary_artifact_blobs" (
	"storage_key" text PRIMARY KEY,
	"bytes" bytea NOT NULL
);
--> statement-breakpoint
CREATE TABLE "binary_artifacts" (
	"workspace_id" text,
	"id" text,
	"execution_id" text,
	"block_id" text,
	"kind" text NOT NULL,
	"view" text,
	"content_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"hash" text NOT NULL,
	"storage" text NOT NULL,
	"storage_key" text NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "binary_artifacts_pkey" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE INDEX "idx_binary_artifacts_execution" ON "binary_artifacts" ("workspace_id","execution_id");--> statement-breakpoint
CREATE INDEX "idx_binary_artifacts_block" ON "binary_artifacts" ("workspace_id","block_id");