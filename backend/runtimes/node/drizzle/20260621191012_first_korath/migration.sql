ALTER TABLE "accounts" ADD COLUMN "default_cloud_provider" text;--> statement-breakpoint
ALTER TABLE "blocks" ADD COLUMN "agent_config" text;--> statement-breakpoint
ALTER TABLE "blocks" ADD COLUMN "test_compose_path" text;--> statement-breakpoint
ALTER TABLE "blocks" ADD COLUMN "no_infra_dependencies" integer;--> statement-breakpoint
ALTER TABLE "blocks" ADD COLUMN "cloud_provider" text;--> statement-breakpoint
ALTER TABLE "blocks" ADD COLUMN "instance_size" text;