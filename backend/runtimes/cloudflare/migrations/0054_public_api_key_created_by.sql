-- Record the minter of an inbound public-API key (workspace-rbac initiative, slice 7 — side
-- doors). A key now carries `created_by_user_id`: the signed-in user who minted it, for audit +
-- UI attribution (the keys panel surfaces "created by"). Nullable — a dev-open mint has no
-- session, and pre-existing rows predate the column. It is NOT an authorization input: a
-- public-API key is a workspace-scoped SERVICE credential that intentionally OUTLIVES its
-- minter's workspace access (revocation is an explicit admin action, so an external integration
-- doesn't break when its author is offboarded). No FK, for the same reason. Mirrored on Node by
-- the `created_by_user_id` column on the Drizzle `public_api_keys` table.
ALTER TABLE public_api_keys ADD COLUMN created_by_user_id TEXT;
