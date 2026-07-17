ALTER TABLE "github_installations" ADD COLUMN "provider" text DEFAULT 'github' NOT NULL;--> statement-breakpoint
ALTER TABLE "github_repos" ADD COLUMN "provider" text DEFAULT 'github' NOT NULL;