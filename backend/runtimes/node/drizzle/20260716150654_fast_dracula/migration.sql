CREATE TABLE "workspace_members" (
	"workspace_id" text,
	"user_id" text,
	"role" text NOT NULL,
	"created_at" bigint NOT NULL,
	"added_by_user_id" text,
	CONSTRAINT "workspace_members_pkey" PRIMARY KEY("workspace_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "access_mode" text DEFAULT 'account' NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_workspace_members_user" ON "workspace_members" ("user_id");--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT;