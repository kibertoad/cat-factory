CREATE TABLE "shared_stacks" (
	"workspace_id" text,
	"id" text,
	"name" text NOT NULL,
	"clone_url" text NOT NULL,
	"git_ref" text,
	"compose_files" text DEFAULT '[]' NOT NULL,
	"compose_profiles" text DEFAULT '[]' NOT NULL,
	"env_files" text DEFAULT '[]' NOT NULL,
	"managed_networks" text DEFAULT '[]' NOT NULL,
	"setup_steps" text DEFAULT '[]' NOT NULL,
	"health_gate" text,
	"allow_host_commands" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'stopped' NOT NULL,
	"last_error" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "shared_stacks_pkey" PRIMARY KEY("workspace_id","id")
);
