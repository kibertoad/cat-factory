CREATE TABLE "auth_attempts" (
	"id" text PRIMARY KEY,
	"key" text NOT NULL,
	"ip" text NOT NULL,
	"at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_auth_attempts_key" ON "auth_attempts" ("key","at");--> statement-breakpoint
CREATE INDEX "idx_auth_attempts_ip" ON "auth_attempts" ("ip","at");--> statement-breakpoint
CREATE INDEX "idx_auth_attempts_at" ON "auth_attempts" ("at");