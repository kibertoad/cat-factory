CREATE TABLE "public_api_key_workspaces" (
	"key_id" text,
	"workspace_id" text,
	CONSTRAINT "public_api_key_workspaces_pkey" PRIMARY KEY("key_id","workspace_id")
);
--> statement-breakpoint
ALTER TABLE "public_api_keys" ADD COLUMN "all_workspaces" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_public_api_key_workspaces_workspace" ON "public_api_key_workspaces" ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_public_api_keys_account" ON "public_api_keys" ("account_id");--> statement-breakpoint
-- Every existing key keeps the one workspace it was minted for (mirror of D1 migration 0108).
INSERT INTO "public_api_key_workspaces" ("key_id", "workspace_id") SELECT "id", "workspace_id" FROM "public_api_keys";