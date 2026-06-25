CREATE TABLE "task_source_settings" (
	"workspace_id" text,
	"source" text,
	"enabled" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "task_source_settings_pkey" PRIMARY KEY("workspace_id","source")
);
