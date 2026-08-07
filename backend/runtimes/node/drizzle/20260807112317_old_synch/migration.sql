-- Several NAMED outbound webhooks per workspace (mirror of D1 migration 0085): re-key
-- notification_webhooks from workspace_id alone to (workspace_id, id).
--
-- Hand-healed before constraining. What `drizzle-kit generate` emitted adds `name` as NOT NULL and
-- `id` as nullable and then makes it half of the primary key, which hard-fails on any deployment
-- that has ever registered a webhook: the NOT NULL add has no default to give the existing rows,
-- and a NULL cannot be part of a primary key. The backfill below is what makes it self-applying,
-- and `default` is the id the singular `/api/v1/notification-webhook` routes now address, so an
-- endpoint registered before this migration keeps both its deliveries and its management route.
ALTER TABLE "notification_webhooks" ADD COLUMN "id" text;--> statement-breakpoint
ALTER TABLE "notification_webhooks" ADD COLUMN "name" text;--> statement-breakpoint
UPDATE "notification_webhooks" SET "id" = 'default' WHERE "id" IS NULL;--> statement-breakpoint
UPDATE "notification_webhooks" SET "name" = 'Default' WHERE "name" IS NULL;--> statement-breakpoint
ALTER TABLE "notification_webhooks" ALTER COLUMN "id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_webhooks" ALTER COLUMN "name" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_webhooks" DROP CONSTRAINT IF EXISTS "notification_webhooks_pkey";--> statement-breakpoint
ALTER TABLE "notification_webhooks" ADD PRIMARY KEY ("workspace_id","id");
