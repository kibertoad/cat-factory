CREATE TABLE "task_connections" (
	"workspace_id" text,
	"source" text,
	"credentials" text NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"created_at" bigint NOT NULL,
	"deleted_at" bigint,
	CONSTRAINT "task_connections_pkey" PRIMARY KEY("workspace_id","source")
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"workspace_id" text,
	"source" text,
	"external_id" text,
	"title" text NOT NULL,
	"url" text NOT NULL,
	"status" text DEFAULT '' NOT NULL,
	"type" text DEFAULT '' NOT NULL,
	"assignee" text,
	"priority" text,
	"labels" text DEFAULT '[]' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"comments" text DEFAULT '[]' NOT NULL,
	"excerpt" text DEFAULT '' NOT NULL,
	"linked_block_id" text,
	"synced_at" bigint NOT NULL,
	"deleted_at" bigint,
	CONSTRAINT "tasks_pkey" PRIMARY KEY("workspace_id","source","external_id")
);
--> statement-breakpoint
CREATE INDEX "idx_tasks_block" ON "tasks" ("workspace_id","linked_block_id");