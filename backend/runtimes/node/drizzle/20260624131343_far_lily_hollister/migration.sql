ALTER TABLE "pipelines" ADD COLUMN "gating" text;--> statement-breakpoint
ALTER TABLE "pipelines" ADD COLUMN "labels" text;--> statement-breakpoint
ALTER TABLE "pipelines" ADD COLUMN "archived" integer;