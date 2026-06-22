CREATE TABLE "github_branches" (
	"workspace_id" text,
	"repo_github_id" bigint,
	"name" text,
	"head_sha" text NOT NULL,
	"protected" integer DEFAULT 0 NOT NULL,
	"synced_at" bigint NOT NULL,
	"deleted_at" bigint,
	CONSTRAINT "github_branches_pkey" PRIMARY KEY("workspace_id","repo_github_id","name")
);
--> statement-breakpoint
CREATE TABLE "github_pull_requests" (
	"workspace_id" text,
	"repo_github_id" bigint,
	"number" integer,
	"github_id" bigint NOT NULL,
	"title" text NOT NULL,
	"state" text NOT NULL,
	"head_ref" text,
	"base_ref" text,
	"head_sha" text,
	"merged" integer DEFAULT 0 NOT NULL,
	"author" text,
	"gh_updated_at" bigint,
	"synced_at" bigint NOT NULL,
	"deleted_at" bigint,
	CONSTRAINT "github_pull_requests_pkey" PRIMARY KEY("workspace_id","repo_github_id","number")
);
--> statement-breakpoint
CREATE TABLE "github_issues" (
	"workspace_id" text,
	"repo_github_id" bigint,
	"number" integer,
	"github_id" bigint NOT NULL,
	"title" text NOT NULL,
	"state" text NOT NULL,
	"author" text,
	"labels" text DEFAULT '[]' NOT NULL,
	"gh_updated_at" bigint,
	"synced_at" bigint NOT NULL,
	"deleted_at" bigint,
	CONSTRAINT "github_issues_pkey" PRIMARY KEY("workspace_id","repo_github_id","number")
);
--> statement-breakpoint
CREATE TABLE "github_commits" (
	"workspace_id" text,
	"repo_github_id" bigint,
	"sha" text,
	"message" text NOT NULL,
	"author" text,
	"authored_at" bigint,
	"synced_at" bigint NOT NULL,
	CONSTRAINT "github_commits_pkey" PRIMARY KEY("workspace_id","repo_github_id","sha")
);
--> statement-breakpoint
CREATE TABLE "github_check_runs" (
	"workspace_id" text,
	"repo_github_id" bigint,
	"github_id" bigint,
	"head_sha" text NOT NULL,
	"name" text NOT NULL,
	"status" text NOT NULL,
	"conclusion" text,
	"synced_at" bigint NOT NULL,
	CONSTRAINT "github_check_runs_pkey" PRIMARY KEY("workspace_id","repo_github_id","github_id")
);
--> statement-breakpoint
CREATE TABLE "github_sync_cursors" (
	"installation_id" bigint,
	"repo_github_id" bigint,
	"kind" text,
	"etag" text,
	"last_synced_at" bigint,
	"since_iso" text,
	CONSTRAINT "github_sync_cursors_pkey" PRIMARY KEY("installation_id","repo_github_id","kind")
);
--> statement-breakpoint
CREATE INDEX "idx_gh_pr_state" ON "github_pull_requests" ("workspace_id","state");--> statement-breakpoint
CREATE INDEX "idx_gh_checks_sha" ON "github_check_runs" ("workspace_id","repo_github_id","head_sha");
