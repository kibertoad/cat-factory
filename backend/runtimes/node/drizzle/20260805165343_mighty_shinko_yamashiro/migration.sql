CREATE TABLE "task_type_suppressions" (
	"workspace_id" text,
	"task_type" text,
	"created_at" bigint NOT NULL,
	CONSTRAINT "task_type_suppressions_pkey" PRIMARY KEY("workspace_id","task_type")
);
