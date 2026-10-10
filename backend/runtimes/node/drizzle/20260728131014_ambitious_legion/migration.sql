ALTER TABLE "telemetry"."llm_call_metrics" ADD COLUMN "cache_read_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "telemetry"."llm_call_metrics" ADD COLUMN "cache_write_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "telemetry"."llm_call_metrics" DROP COLUMN "cached_prompt_tokens";