CREATE TABLE "account_invitations" (
	"id" text PRIMARY KEY,
	"account_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"token_hash" text NOT NULL,
	"invited_by" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" bigint NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" text PRIMARY KEY,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"github_account_login" text,
	"owner_user_id" text,
	"created_at" bigint NOT NULL,
	"default_cloud_provider" text
);
--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"workspace_id" text,
	"id" text,
	"kind" text NOT NULL,
	"block_id" text,
	"status" text NOT NULL,
	"detail" text DEFAULT '{}' NOT NULL,
	"subtasks" text,
	"error" text,
	"failure" text,
	"workflow_instance_id" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"service_id" text,
	CONSTRAINT "agent_runs_pkey" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "blocks" (
	"workspace_id" text,
	"id" text,
	"title" text NOT NULL,
	"type" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"pos_x" double precision DEFAULT 0 NOT NULL,
	"pos_y" double precision DEFAULT 0 NOT NULL,
	"width" double precision,
	"height" double precision,
	"status" text NOT NULL,
	"progress" double precision DEFAULT 0 NOT NULL,
	"depends_on" text DEFAULT '[]' NOT NULL,
	"execution_id" text,
	"level" text DEFAULT 'frame' NOT NULL,
	"parent_id" text,
	"confidence" double precision,
	"module_name" text,
	"fragment_ids" text,
	"service_fragment_ids" text,
	"model_id" text,
	"pull_request" text,
	"merge_preset_id" text,
	"pipeline_id" text,
	"agent_config" text,
	"test_compose_path" text,
	"no_infra_dependencies" integer,
	"cloud_provider" text,
	"instance_size" text,
	"service_id" text,
	"created_by" text,
	CONSTRAINT "blocks_pkey" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "document_connections" (
	"workspace_id" text,
	"source" text,
	"credentials" text NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"created_at" bigint NOT NULL,
	"deleted_at" bigint,
	CONSTRAINT "document_connections_pkey" PRIMARY KEY("workspace_id","source")
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"workspace_id" text,
	"source" text,
	"external_id" text,
	"title" text NOT NULL,
	"url" text NOT NULL,
	"excerpt" text DEFAULT '' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"linked_block_id" text,
	"synced_at" bigint NOT NULL,
	"deleted_at" bigint,
	CONSTRAINT "documents_pkey" PRIMARY KEY("workspace_id","source","external_id")
);
--> statement-breakpoint
CREATE TABLE "email_connections" (
	"account_id" text PRIMARY KEY,
	"provider" text NOT NULL,
	"from_address" text NOT NULL,
	"api_key_cipher" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"deleted_at" bigint
);
--> statement-breakpoint
CREATE TABLE "environment_connections" (
	"workspace_id" text,
	"provider_id" text,
	"label" text NOT NULL,
	"base_url" text NOT NULL,
	"manifest_json" text NOT NULL,
	"secrets_cipher" text NOT NULL,
	"created_at" bigint NOT NULL,
	"deleted_at" bigint,
	CONSTRAINT "environment_connections_pkey" PRIMARY KEY("workspace_id","provider_id")
);
--> statement-breakpoint
CREATE TABLE "environments" (
	"id" text PRIMARY KEY,
	"workspace_id" text NOT NULL,
	"block_id" text,
	"execution_id" text,
	"provider_id" text NOT NULL,
	"external_id" text,
	"url" text,
	"status" text NOT NULL,
	"access_cipher" text,
	"provision_fields_cipher" text,
	"created_at" bigint NOT NULL,
	"expires_at" bigint,
	"last_error" text,
	"deleted_at" bigint
);
--> statement-breakpoint
CREATE TABLE "fragment_sources" (
	"id" text PRIMARY KEY,
	"owner_kind" text NOT NULL,
	"owner_id" text NOT NULL,
	"repo_owner" text NOT NULL,
	"repo_name" text NOT NULL,
	"git_ref" text DEFAULT 'HEAD' NOT NULL,
	"dir_path" text DEFAULT '' NOT NULL,
	"last_synced_sha" text,
	"last_synced_at" bigint,
	"created_at" bigint NOT NULL,
	"deleted_at" bigint
);
--> statement-breakpoint
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
CREATE TABLE "github_installations" (
	"installation_id" bigint PRIMARY KEY,
	"workspace_id" text NOT NULL,
	"account_id" text,
	"account_login" text NOT NULL,
	"target_type" text NOT NULL,
	"app_id" text,
	"cached_token" text,
	"token_expires_at" bigint,
	"created_at" bigint NOT NULL,
	"deleted_at" bigint
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
CREATE TABLE "github_repos" (
	"workspace_id" text,
	"github_id" bigint,
	"installation_id" bigint NOT NULL,
	"owner" text NOT NULL,
	"name" text NOT NULL,
	"default_branch" text,
	"private" integer DEFAULT 0 NOT NULL,
	"block_id" text,
	"is_monorepo" integer DEFAULT 0 NOT NULL,
	"etag" text,
	"synced_at" bigint NOT NULL,
	"deleted_at" bigint,
	CONSTRAINT "github_repos_pkey" PRIMARY KEY("workspace_id","github_id")
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
CREATE TABLE "llm_call_metrics" (
	"id" text PRIMARY KEY,
	"workspace_id" text NOT NULL,
	"execution_id" text,
	"agent_kind" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"created_at" bigint NOT NULL,
	"streaming" integer DEFAULT 0 NOT NULL,
	"message_count" integer DEFAULT 0 NOT NULL,
	"tool_count" integer DEFAULT 0 NOT NULL,
	"request_max_tokens" integer,
	"prompt_tokens" integer DEFAULT 0 NOT NULL,
	"cached_prompt_tokens" integer DEFAULT 0 NOT NULL,
	"completion_tokens" integer DEFAULT 0 NOT NULL,
	"total_tokens" integer DEFAULT 0 NOT NULL,
	"finish_reason" text,
	"upstream_ms" integer DEFAULT 0 NOT NULL,
	"overhead_ms" integer DEFAULT 0 NOT NULL,
	"total_ms" integer DEFAULT 0 NOT NULL,
	"ok" integer DEFAULT 1 NOT NULL,
	"http_status" integer,
	"error_message" text,
	"prompt_text" text DEFAULT '' NOT NULL,
	"prompt_prefix_count" integer DEFAULT 0 NOT NULL,
	"prompt_hash" text DEFAULT '' NOT NULL,
	"response_text" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"account_id" text,
	"user_id" text,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "memberships_pkey" PRIMARY KEY("account_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "merge_threshold_presets" (
	"workspace_id" text,
	"id" text,
	"name" text NOT NULL,
	"max_complexity" double precision NOT NULL,
	"max_risk" double precision NOT NULL,
	"max_impact" double precision NOT NULL,
	"ci_max_attempts" integer NOT NULL,
	"is_default" integer DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "merge_threshold_presets_pkey" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"workspace_id" text,
	"id" text,
	"type" text NOT NULL,
	"status" text NOT NULL,
	"block_id" text,
	"execution_id" text,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"payload" text,
	"created_at" bigint NOT NULL,
	"resolved_at" bigint,
	CONSTRAINT "notifications_pkey" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "personal_subscriptions" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"vendor" text NOT NULL,
	"label" text NOT NULL,
	"token_cipher" text NOT NULL,
	"expires_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"last_used_at" bigint,
	"deleted_at" bigint
);
--> statement-breakpoint
CREATE TABLE "pipeline_schedule_runs" (
	"workspace_id" text,
	"id" text,
	"schedule_id" text NOT NULL,
	"execution_id" text,
	"status" text NOT NULL,
	"started_at" bigint NOT NULL,
	"finished_at" bigint,
	"outcome" text,
	CONSTRAINT "pipeline_schedule_runs_pkey" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "pipeline_schedules" (
	"workspace_id" text,
	"id" text,
	"service_id" text,
	"block_id" text NOT NULL,
	"frame_id" text NOT NULL,
	"pipeline_id" text NOT NULL,
	"template" text NOT NULL,
	"name" text NOT NULL,
	"interval_hours" integer NOT NULL,
	"weekdays" text DEFAULT '[]' NOT NULL,
	"window_start_hour" integer,
	"window_end_hour" integer,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"enabled" integer DEFAULT 1 NOT NULL,
	"last_run_at" bigint,
	"next_run_at" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "pipeline_schedules_pkey" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "pipelines" (
	"workspace_id" text,
	"id" text,
	"name" text NOT NULL,
	"agent_kinds" text DEFAULT '[]' NOT NULL,
	"gates" text,
	"thresholds" text,
	"seq" serial,
	CONSTRAINT "pipelines_pkey" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "prompt_fragments" (
	"fragment_id" text,
	"owner_kind" text,
	"owner_id" text,
	"version" text NOT NULL,
	"title" text NOT NULL,
	"category" text,
	"summary" text NOT NULL,
	"body" text NOT NULL,
	"applies_to" text,
	"tags" text,
	"source_id" text,
	"source_path" text,
	"source_sha" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"deleted_at" bigint,
	CONSTRAINT "prompt_fragments_pkey" PRIMARY KEY("owner_kind","owner_id","fragment_id")
);
--> statement-breakpoint
CREATE TABLE "provider_subscription_tokens" (
	"id" text PRIMARY KEY,
	"workspace_id" text NOT NULL,
	"vendor" text NOT NULL,
	"label" text NOT NULL,
	"token_cipher" text NOT NULL,
	"created_at" bigint NOT NULL,
	"last_used_at" bigint,
	"window_started_at" bigint,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"request_count" integer DEFAULT 0 NOT NULL,
	"deleted_at" bigint
);
--> statement-breakpoint
CREATE TABLE "reference_architectures" (
	"id" text PRIMARY KEY,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"repo_owner" text NOT NULL,
	"repo_name" text NOT NULL,
	"default_instructions" text DEFAULT '' NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"deleted_at" bigint
);
--> statement-breakpoint
CREATE TABLE "repo_blueprints" (
	"id" text PRIMARY KEY,
	"workspace_id" text NOT NULL,
	"repo_owner" text NOT NULL,
	"repo_name" text NOT NULL,
	"source" text NOT NULL,
	"service_json" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "requirement_reviews" (
	"workspace_id" text,
	"id" text,
	"block_id" text NOT NULL,
	"status" text NOT NULL,
	"items" text DEFAULT '[]' NOT NULL,
	"model" text,
	"incorporated_requirements" text,
	"companion" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "requirement_reviews_pkey" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "runner_pool_connections" (
	"workspace_id" text,
	"provider_id" text,
	"label" text NOT NULL,
	"base_url" text NOT NULL,
	"manifest_json" text NOT NULL,
	"secrets_cipher" text NOT NULL,
	"created_at" bigint NOT NULL,
	"deleted_at" bigint,
	CONSTRAINT "runner_pool_connections_pkey" PRIMARY KEY("workspace_id","provider_id")
);
--> statement-breakpoint
CREATE TABLE "services" (
	"id" text PRIMARY KEY,
	"account_id" text,
	"frame_block_id" text NOT NULL,
	"installation_id" bigint,
	"repo_github_id" bigint,
	"directory" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slack_connections" (
	"account_id" text PRIMARY KEY,
	"team_id" text NOT NULL,
	"team_name" text NOT NULL,
	"team_icon_url" text,
	"bot_user_id" text,
	"scopes" text,
	"token_cipher" text NOT NULL,
	"created_at" bigint NOT NULL,
	"deleted_at" bigint
);
--> statement-breakpoint
CREATE TABLE "slack_member_mappings" (
	"account_id" text PRIMARY KEY,
	"entries" text DEFAULT '[]' NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slack_settings" (
	"workspace_id" text PRIMARY KEY,
	"routes" text DEFAULT '{}' NOT NULL,
	"mentions_enabled" integer DEFAULT 0 NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscription_activations" (
	"id" text PRIMARY KEY,
	"execution_id" text NOT NULL,
	"user_id" text NOT NULL,
	"vendor" text NOT NULL,
	"token_cipher" text NOT NULL,
	"created_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_connections" (
	"workspace_id" text,
	"source" text,
	"credentials" text NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"created_at" bigint NOT NULL,
	"deleted_at" bigint,
	CONSTRAINT "task_connections_pkey" PRIMARY KEY("workspace_id","source")
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"workspace_id" text,
	"source" text,
	"external_id" text,
	"title" text NOT NULL,
	"url" text NOT NULL,
	"status" text DEFAULT '' NOT NULL,
	"type" text DEFAULT '' NOT NULL,
	"assignee" text,
	"priority" text,
	"labels" text DEFAULT '[]' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"comments" text DEFAULT '[]' NOT NULL,
	"excerpt" text DEFAULT '' NOT NULL,
	"linked_block_id" text,
	"synced_at" bigint NOT NULL,
	"deleted_at" bigint,
	CONSTRAINT "tasks_pkey" PRIMARY KEY("workspace_id","source","external_id")
);
--> statement-breakpoint
CREATE TABLE "token_usage" (
	"id" text PRIMARY KEY,
	"workspace_id" text NOT NULL,
	"execution_id" text,
	"agent_kind" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_estimate" double precision DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tracker_settings" (
	"workspace_id" text PRIMARY KEY,
	"tracker" text,
	"jira_project_key" text,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_identities" (
	"user_id" text NOT NULL,
	"provider" text,
	"subject" text,
	"secret" text,
	"metadata" text,
	"created_at" bigint NOT NULL,
	CONSTRAINT "user_identities_pkey" PRIMARY KEY("provider","subject")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY,
	"name" text,
	"email" text,
	"avatar_url" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_fragment_defaults" (
	"workspace_id" text PRIMARY KEY,
	"fragment_ids" text NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_model_defaults" (
	"workspace_id" text,
	"agent_kind" text,
	"model_id" text NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "workspace_model_defaults_pkey" PRIMARY KEY("workspace_id","agent_kind")
);
--> statement-breakpoint
CREATE TABLE "workspace_services" (
	"workspace_id" text,
	"service_id" text,
	"pos_x" double precision DEFAULT 0 NOT NULL,
	"pos_y" double precision DEFAULT 0 NOT NULL,
	"width" double precision,
	"height" double precision,
	"created_at" bigint NOT NULL,
	CONSTRAINT "workspace_services_pkey" PRIMARY KEY("workspace_id","service_id")
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"description" text,
	"created_at" bigint NOT NULL,
	"account_id" text,
	"owner_user_id" text
);
--> statement-breakpoint
CREATE INDEX "idx_account_invitations_account" ON "account_invitations" ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_account_invitations_token" ON "account_invitations" ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_accounts_personal" ON "accounts" ("owner_user_id") WHERE type = 'personal';--> statement-breakpoint
CREATE INDEX "idx_agent_runs_workspace" ON "agent_runs" ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_agent_runs_status_lease" ON "agent_runs" ("status","updated_at");--> statement-breakpoint
CREATE INDEX "idx_agent_runs_block" ON "agent_runs" ("workspace_id","block_id");--> statement-breakpoint
CREATE INDEX "idx_agent_runs_service" ON "agent_runs" ("service_id");--> statement-breakpoint
CREATE INDEX "idx_blocks_parent" ON "blocks" ("workspace_id","parent_id");--> statement-breakpoint
CREATE INDEX "idx_blocks_service" ON "blocks" ("service_id");--> statement-breakpoint
CREATE INDEX "idx_blocks_id" ON "blocks" ("id");--> statement-breakpoint
CREATE INDEX "idx_documents_block" ON "documents" ("workspace_id","linked_block_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_environment_conn_workspace" ON "environment_connections" ("workspace_id") WHERE "deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_environments_block" ON "environments" ("workspace_id","block_id") WHERE "deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_environments_expiry" ON "environments" ("expires_at") WHERE "deleted_at" IS NULL AND "expires_at" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_fragment_sources_unique" ON "fragment_sources" ("owner_kind","owner_id","repo_owner","repo_name","git_ref","dir_path");--> statement-breakpoint
CREATE INDEX "idx_fragment_sources_owner" ON "fragment_sources" ("owner_kind","owner_id") WHERE "deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_gh_checks_sha" ON "github_check_runs" ("workspace_id","repo_github_id","head_sha");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_gh_install_workspace" ON "github_installations" ("workspace_id") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "idx_gh_install_account" ON "github_installations" ("account_id") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "idx_gh_pr_state" ON "github_pull_requests" ("workspace_id","state");--> statement-breakpoint
CREATE INDEX "idx_gh_repos_install" ON "github_repos" ("installation_id");--> statement-breakpoint
CREATE INDEX "idx_llm_call_metrics_execution" ON "llm_call_metrics" ("workspace_id","execution_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_llm_call_metrics_created" ON "llm_call_metrics" ("created_at");--> statement-breakpoint
CREATE INDEX "idx_memberships_user" ON "memberships" ("user_id");--> statement-breakpoint
CREATE INDEX "idx_merge_presets_default" ON "merge_threshold_presets" ("workspace_id","is_default");--> statement-breakpoint
CREATE INDEX "idx_notifications_open" ON "notifications" ("workspace_id","status","created_at");--> statement-breakpoint
CREATE INDEX "idx_notifications_block" ON "notifications" ("workspace_id","block_id","type","status");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_personal_subs_user_vendor" ON "personal_subscriptions" ("user_id","vendor") WHERE "deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_personal_subs_expiry" ON "personal_subscriptions" ("expires_at") WHERE "deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_schedule_runs_schedule" ON "pipeline_schedule_runs" ("workspace_id","schedule_id","started_at");--> statement-breakpoint
CREATE INDEX "idx_schedule_runs_started" ON "pipeline_schedule_runs" ("started_at");--> statement-breakpoint
CREATE INDEX "idx_pipeline_schedules_due" ON "pipeline_schedules" ("enabled","next_run_at");--> statement-breakpoint
CREATE INDEX "idx_pipeline_schedules_block" ON "pipeline_schedules" ("workspace_id","block_id");--> statement-breakpoint
CREATE INDEX "idx_pipeline_schedules_service" ON "pipeline_schedules" ("service_id");--> statement-breakpoint
CREATE INDEX "idx_prompt_fragments_owner" ON "prompt_fragments" ("owner_kind","owner_id") WHERE "deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_prompt_fragments_source" ON "prompt_fragments" ("source_id") WHERE "deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_provider_subs_pool" ON "provider_subscription_tokens" ("workspace_id","vendor","deleted_at");--> statement-breakpoint
CREATE INDEX "idx_reference_architectures_workspace" ON "reference_architectures" ("workspace_id") WHERE "deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_repo_blueprints_repo" ON "repo_blueprints" ("workspace_id","repo_owner","repo_name");--> statement-breakpoint
CREATE INDEX "idx_repo_blueprints_workspace" ON "repo_blueprints" ("workspace_id","updated_at");--> statement-breakpoint
CREATE INDEX "idx_requirement_reviews_block" ON "requirement_reviews" ("workspace_id","block_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_runner_pool_conn_workspace" ON "runner_pool_connections" ("workspace_id") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "idx_services_account" ON "services" ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_services_frame" ON "services" ("account_id","frame_block_id");--> statement-breakpoint
CREATE INDEX "idx_services_frame_block" ON "services" ("frame_block_id");--> statement-breakpoint
CREATE INDEX "idx_services_repo" ON "services" ("installation_id","repo_github_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_slack_conn_team" ON "slack_connections" ("team_id") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_sub_activations_run" ON "subscription_activations" ("execution_id","user_id","vendor");--> statement-breakpoint
CREATE INDEX "idx_sub_activations_expiry" ON "subscription_activations" ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_tasks_block" ON "tasks" ("workspace_id","linked_block_id");--> statement-breakpoint
CREATE INDEX "idx_token_usage_created" ON "token_usage" ("created_at");--> statement-breakpoint
CREATE INDEX "idx_user_identities_user" ON "user_identities" ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_users_email" ON "users" ("email") WHERE email IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_workspace_services_service" ON "workspace_services" ("service_id");--> statement-breakpoint
CREATE INDEX "idx_workspaces_owner" ON "workspaces" ("owner_user_id");--> statement-breakpoint
CREATE INDEX "idx_workspaces_account" ON "workspaces" ("account_id");