ALTER TABLE "github_repos" ADD COLUMN "is_monorepo" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "directory" text;