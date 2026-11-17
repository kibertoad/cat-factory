ALTER TABLE "project_outcomes" ADD COLUMN "task_type" text;
--> statement-breakpoint
UPDATE "project_outcomes" SET "task_type" = "blocks"."task_type" FROM "blocks" WHERE "blocks"."id" = "project_outcomes"."task_id";
