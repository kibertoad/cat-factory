-- Account roles + responsible product person.
--
-- Memberships and invitations gain a combinable ROLE SET (admin / developer /
-- product) stored as a CSV `roles` column, replacing the single owner|member `role`.
-- Per the pre-1.0 no-backwards-compat policy there is NO backfill: existing rows take
-- the `developer` default (a fresh admin membership is created on next sign-in), and
-- the old `role` column is left orphaned. Blocks gain the responsible product person.

ALTER TABLE memberships ADD COLUMN roles TEXT NOT NULL DEFAULT 'developer';
ALTER TABLE account_invitations ADD COLUMN roles TEXT NOT NULL DEFAULT 'developer';

-- The account member (a product role-holder) responsible for a task; notified when
-- requirement review flags findings. Null when unassigned.
ALTER TABLE blocks ADD COLUMN responsible_product_user_id TEXT;
