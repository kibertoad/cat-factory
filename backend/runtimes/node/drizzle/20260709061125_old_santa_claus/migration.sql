-- Heal pre-existing orphans BEFORE adding the ON DELETE RESTRICT foreign keys. On any DB old
-- enough to predate these FKs, a users row could be deleted while its dependents lived on, so
-- adding the constraint against dirty data would hard-fail with a bare `23503`. Delete the
-- dangling dependents (NULL the nullable accounts.owner_user_id) so the migration is
-- self-applying. This is the same heal ON DELETE CASCADE would have done; losing orphaned rows
-- is acceptable (backwards compatibility is a non-goal). The root cause — what removes a users
-- row while leaving dependents — is tracked separately (the account-orphaning investigation).
DELETE FROM "memberships" WHERE "user_id" NOT IN (SELECT "id" FROM "users");--> statement-breakpoint
DELETE FROM "personal_subscriptions" WHERE "user_id" NOT IN (SELECT "id" FROM "users");--> statement-breakpoint
DELETE FROM "subscription_activations" WHERE "user_id" NOT IN (SELECT "id" FROM "users");--> statement-breakpoint
DELETE FROM "user_identities" WHERE "user_id" NOT IN (SELECT "id" FROM "users");--> statement-breakpoint
UPDATE "accounts" SET "owner_user_id" = NULL WHERE "owner_user_id" IS NOT NULL AND "owner_user_id" NOT IN (SELECT "id" FROM "users");--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_owner_user_id_users_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "personal_subscriptions" ADD CONSTRAINT "personal_subscriptions_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "subscription_activations" ADD CONSTRAINT "subscription_activations_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT;
