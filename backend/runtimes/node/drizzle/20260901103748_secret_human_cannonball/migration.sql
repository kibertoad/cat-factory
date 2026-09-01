-- Record what a GATEWAY reports about a call, rather than only what we can derive about it.
-- The Node half of D1 telemetry migration 0007_llm_call_gateway_attribution, which carries the
-- full reasoning. In short: both columns are NULLABLE and NULL is the load-bearing value, because
-- every other cost on this table is DERIVED from the spend price table and a 0 would claim a free
-- call rather than an unreported one. `reported_cost_usd` stays in the vendor's own USD.
ALTER TABLE "telemetry"."llm_call_metrics" ADD COLUMN "reported_cost_usd" double precision;--> statement-breakpoint
ALTER TABLE "telemetry"."llm_call_metrics" ADD COLUMN "upstream_provider" text;