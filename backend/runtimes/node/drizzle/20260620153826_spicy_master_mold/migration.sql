DROP INDEX "idx_services_frame";--> statement-breakpoint
CREATE UNIQUE INDEX "idx_services_frame" ON "services" ("account_id","frame_block_id");