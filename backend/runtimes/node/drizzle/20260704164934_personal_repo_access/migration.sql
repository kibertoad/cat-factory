CREATE TABLE "github_user_repo_access" (
	"user_id" text,
	"repo_github_id" bigint,
	"owner" text NOT NULL,
	"name" text NOT NULL,
	"default_branch" text,
	"private" integer DEFAULT 0 NOT NULL,
	"synced_at" bigint NOT NULL,
	CONSTRAINT "github_user_repo_access_pkey" PRIMARY KEY("user_id","repo_github_id")
);
--> statement-breakpoint
ALTER TABLE "github_repos" ADD COLUMN "linked_via" text DEFAULT 'app' NOT NULL;--> statement-breakpoint
ALTER TABLE "github_repos" DROP COLUMN "block_id";--> statement-breakpoint
CREATE INDEX "idx_gh_user_repo_access_repo" ON "github_user_repo_access" ("repo_github_id");