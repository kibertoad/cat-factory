CREATE TABLE "tutorial_progress" (
	"user_id" text PRIMARY KEY,
	"decision" text,
	"completed_tour_ids" text DEFAULT '[]' NOT NULL,
	"nudged_tour_ids" text DEFAULT '[]' NOT NULL,
	"updated_at" bigint NOT NULL
);
