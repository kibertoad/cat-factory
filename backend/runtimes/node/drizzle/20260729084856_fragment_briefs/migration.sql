CREATE TABLE "fragment_briefs" (
	"owner_kind" text,
	"owner_id" text,
	"fragment_id" text,
	"body_fingerprint" text NOT NULL,
	"brief" text NOT NULL,
	"model" text NOT NULL,
	"generated_at" bigint NOT NULL,
	CONSTRAINT "fragment_briefs_pkey" PRIMARY KEY("owner_kind","owner_id","fragment_id")
);
--> statement-breakpoint
ALTER TABLE "prompt_fragments" ADD COLUMN "brief" text;