ALTER TABLE "brainstorm_sessions" ADD COLUMN "rev" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "clarity_reviews" ADD COLUMN "rev" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "requirement_reviews" ADD COLUMN "rev" integer DEFAULT 0 NOT NULL;