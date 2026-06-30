-- Per-service provision type + per-type infra handlers (slice 2b, breaking). Reshape
-- environment_connections from a single per-workspace provider binding into a multi-row
-- per-provision-type handler table keyed by (workspace_id, provision_type, manifest_id).
-- Backwards compatibility is NOT a goal (CLAUDE.md): clean DROP/CREATE, stale rows dropped.
DROP TABLE IF EXISTS "environment_connections" CASCADE;
--> statement-breakpoint
CREATE TABLE "environment_connections" (
	"workspace_id" text,
	"provision_type" text,
	"manifest_id" text DEFAULT '',
	"engine" text NOT NULL,
	"backend_kind" text NOT NULL,
	"provider_id" text NOT NULL,
	"label" text NOT NULL,
	"base_url" text NOT NULL,
	"handler_json" text NOT NULL,
	"accepts_manifest_id" text,
	"secrets_cipher" text NOT NULL,
	"created_at" bigint NOT NULL,
	"deleted_at" bigint,
	CONSTRAINT "environment_connections_pkey" PRIMARY KEY("workspace_id","provision_type","manifest_id")
);
--> statement-breakpoint
CREATE INDEX "idx_environment_conn_workspace" ON "environment_connections" ("workspace_id") WHERE "deleted_at" IS NULL;
