CREATE TABLE "tracker_comment_ingests" (
	"workspace_id" text,
	"source" text,
	"external_id" text,
	"comment_id" text,
	"status" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "tracker_comment_ingests_pkey" PRIMARY KEY("workspace_id","source","external_id","comment_id")
);
