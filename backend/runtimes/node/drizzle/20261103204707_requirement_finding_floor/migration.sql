ALTER TABLE "requirement_reviews" ADD COLUMN "finding_floor" text;--> statement-breakpoint
ALTER TABLE "merge_threshold_presets" ADD COLUMN "requirement_finding_floor" text DEFAULT 'medium' NOT NULL;--> statement-breakpoint
ALTER TABLE "merge_threshold_presets" ADD COLUMN "requirement_floor_progression" text;--> statement-breakpoint
ALTER TABLE "account_risk_policies" ADD COLUMN "requirement_finding_floor" text DEFAULT 'medium' NOT NULL;--> statement-breakpoint
ALTER TABLE "account_risk_policies" ADD COLUMN "requirement_floor_progression" text;