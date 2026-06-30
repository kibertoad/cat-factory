ALTER TABLE "blocks" DROP COLUMN "test_compose_path";--> statement-breakpoint
ALTER TABLE "blocks" DROP COLUMN "no_infra_dependencies";--> statement-breakpoint
ALTER TABLE "blocks" DROP COLUMN "default_test_environment";--> statement-breakpoint
ALTER TABLE "workspace_settings" DROP COLUMN "delegate_test_env_to_provider";