ALTER TABLE "environments" ADD COLUMN "last_polled_at" bigint;--> statement-breakpoint
ALTER TABLE "environments" ADD COLUMN "poll_count" bigint DEFAULT 0 NOT NULL;