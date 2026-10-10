ALTER TABLE "public_api_keys" ADD COLUMN "created_by_key_id" text;--> statement-breakpoint
CREATE INDEX "idx_public_api_keys_minter" ON "public_api_keys" ("created_by_key_id");