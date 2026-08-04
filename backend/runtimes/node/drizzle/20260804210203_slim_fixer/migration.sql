CREATE SCHEMA "audit";
--> statement-breakpoint
CREATE TABLE "audit"."audit_events" (
	"id" text PRIMARY KEY,
	"account_id" text NOT NULL,
	"workspace_id" text,
	"actor_kind" text NOT NULL,
	"actor_user_id" text,
	"actor_api_key_id" text,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"summary" text NOT NULL,
	"at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_audit_events_account_at" ON "audit"."audit_events" ("account_id","at" DESC NULLS LAST,"id" DESC NULLS LAST);