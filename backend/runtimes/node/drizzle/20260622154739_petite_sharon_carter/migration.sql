ALTER TABLE "merge_threshold_presets" ADD COLUMN "max_requirement_iterations" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "merge_threshold_presets" ADD COLUMN "max_requirement_concern_allowed" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "requirement_reviews" ADD COLUMN "iteration" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "requirement_reviews" ADD COLUMN "max_iterations" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "requirement_reviews" DROP COLUMN "companion";