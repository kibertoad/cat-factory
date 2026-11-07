CREATE TABLE "research_task_seqs" (
	"task_id" text PRIMARY KEY,
	"project_id" text NOT NULL,
	"seq" integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_research_task_seqs_seq" ON "research_task_seqs" ("project_id","seq");
