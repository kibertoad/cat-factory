CREATE TABLE "directory_webhooks" (
	"account_id" text,
	"id" text,
	"url" text NOT NULL,
	"enabled" integer DEFAULT 1 NOT NULL,
	"secret_sealed" text,
	"delivered_seq" bigint DEFAULT 0 NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "directory_webhooks_pkey" PRIMARY KEY("account_id","id")
);
