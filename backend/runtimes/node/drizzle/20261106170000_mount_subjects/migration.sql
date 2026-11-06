ALTER TABLE "blocks" RENAME COLUMN "service_id" TO "owner_id";--> statement-breakpoint
ALTER INDEX "idx_blocks_service" RENAME TO "idx_blocks_owner";--> statement-breakpoint
ALTER TABLE "agent_runs" RENAME COLUMN "service_id" TO "owner_id";--> statement-breakpoint
ALTER INDEX "idx_agent_runs_service" RENAME TO "idx_agent_runs_owner";--> statement-breakpoint
ALTER TABLE "workspace_services" RENAME TO "workspace_mounts";--> statement-breakpoint
ALTER TABLE "workspace_mounts" RENAME COLUMN "service_id" TO "subject_id";--> statement-breakpoint
ALTER TABLE "workspace_mounts" RENAME CONSTRAINT "workspace_services_pkey" TO "workspace_mounts_pkey";--> statement-breakpoint
ALTER INDEX "idx_workspace_services_service" RENAME TO "idx_workspace_mounts_subject";
