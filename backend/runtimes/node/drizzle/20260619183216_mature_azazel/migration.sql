ALTER TABLE "llm_call_metrics" ADD COLUMN "prompt_prefix_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "llm_call_metrics" ADD COLUMN "prompt_hash" text DEFAULT '' NOT NULL;