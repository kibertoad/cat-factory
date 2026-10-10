CREATE TABLE "machine_nodes" (
	"node_id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"account_ids" text NOT NULL,
	"created_at" bigint NOT NULL,
	"last_minted_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	"revoked_at" bigint,
	"revoked_by" text
);
--> statement-breakpoint
CREATE INDEX "idx_machine_nodes_user" ON "machine_nodes" ("user_id");--> statement-breakpoint
CREATE INDEX "idx_machine_nodes_expiry" ON "machine_nodes" ("expires_at");