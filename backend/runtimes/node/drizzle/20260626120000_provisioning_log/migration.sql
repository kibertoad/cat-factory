CREATE SCHEMA "provisioning";
--> statement-breakpoint
CREATE TABLE "provisioning"."provisioning_log" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"subsystem" text NOT NULL,
	"operation" text NOT NULL,
	"target_id" text,
	"provider_id" text,
	"block_id" text,
	"execution_id" text,
	"outcome" text NOT NULL,
	"error" text,
	"detail" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_provisioning_log_workspace" ON "provisioning"."provisioning_log" USING btree ("workspace_id","created_at");
--> statement-breakpoint
CREATE INDEX "idx_provisioning_log_subsystem" ON "provisioning"."provisioning_log" USING btree ("workspace_id","subsystem","created_at");
--> statement-breakpoint
CREATE INDEX "idx_provisioning_log_execution" ON "provisioning"."provisioning_log" USING btree ("workspace_id","execution_id","created_at");
--> statement-breakpoint
CREATE INDEX "idx_provisioning_log_target" ON "provisioning"."provisioning_log" USING btree ("workspace_id","target_id");
--> statement-breakpoint
CREATE INDEX "idx_provisioning_log_created" ON "provisioning"."provisioning_log" USING btree ("created_at");
