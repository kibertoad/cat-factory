CREATE TABLE "task_project_links" (
	"workspace_id" text NOT NULL,
	"block_id" text NOT NULL,
	"project_id" text NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "task_project_links_pkey" PRIMARY KEY("workspace_id","block_id","project_id")
);
--> statement-breakpoint
CREATE INDEX "idx_task_project_links_project" ON "task_project_links" ("project_id");
