ALTER TABLE "telemetry"."llm_call_metrics" ADD COLUMN "phase" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "telemetry"."llm_call_metrics" ADD COLUMN "turn_index" integer;