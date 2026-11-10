CREATE TABLE "project_task_seqs" (
	"task_id" text PRIMARY KEY,
	"project_id" text NOT NULL,
	"seq" integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_project_task_seqs_seq" ON "project_task_seqs" ("project_id","seq");