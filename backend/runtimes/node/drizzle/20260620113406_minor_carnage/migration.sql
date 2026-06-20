CREATE TABLE "services" (
	"id" text PRIMARY KEY,
	"account_id" text,
	"frame_block_id" text NOT NULL,
	"installation_id" bigint,
	"repo_github_id" bigint,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_services" (
	"workspace_id" text,
	"service_id" text,
	"pos_x" double precision DEFAULT 0 NOT NULL,
	"pos_y" double precision DEFAULT 0 NOT NULL,
	"width" double precision,
	"height" double precision,
	"created_at" bigint NOT NULL,
	CONSTRAINT "workspace_services_pkey" PRIMARY KEY("workspace_id","service_id")
);
--> statement-breakpoint
CREATE INDEX "idx_services_account" ON "services" ("account_id");--> statement-breakpoint
CREATE INDEX "idx_services_frame" ON "services" ("frame_block_id");--> statement-breakpoint
CREATE INDEX "idx_services_repo" ON "services" ("installation_id","repo_github_id");--> statement-breakpoint
CREATE INDEX "idx_workspace_services_service" ON "workspace_services" ("service_id");--> statement-breakpoint
INSERT INTO "services" ("id", "account_id", "frame_block_id", "installation_id", "repo_github_id", "created_at")
SELECT b.workspace_id || ':' || b.id, w.account_id, b.id, r.installation_id, r.github_id,
  (extract(epoch from now()) * 1000)::bigint
FROM blocks b
JOIN workspaces w ON w.id = b.workspace_id
LEFT JOIN github_repos r
  ON r.workspace_id = b.workspace_id AND r.block_id = b.id AND r.deleted_at IS NULL
WHERE b.level = 'frame' AND b.parent_id IS NULL;--> statement-breakpoint
INSERT INTO "workspace_services" ("workspace_id", "service_id", "pos_x", "pos_y", "width", "height", "created_at")
SELECT b.workspace_id, b.workspace_id || ':' || b.id, b.pos_x, b.pos_y, b.width, b.height,
  (extract(epoch from now()) * 1000)::bigint
FROM blocks b
WHERE b.level = 'frame' AND b.parent_id IS NULL;