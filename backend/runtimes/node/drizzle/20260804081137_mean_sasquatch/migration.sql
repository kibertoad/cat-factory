CREATE TABLE "platform_rollup_state" (
	"rollup" text PRIMARY KEY,
	"through_day" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
