-- Record which KEY minted an inbound public-API key, for the headless provisioning surface
-- (`POST /api/v1/keys`). Set only for a key minted over the API; NULL for one a person minted in
-- the app, and for every row predating the column.
--
-- It is provenance AND a lifecycle link: `PublicApiKeyService.revoke` revokes every key its
-- target minted, which is what stops a leaked provisioning key outliving its own revocation
-- through the keys it left behind. The index serves exactly that cascade.
--
-- No FK, for the same reason `created_by_user_id` has none: a key is a workspace-scoped SERVICE
-- credential and the row has to survive whatever minted it being deleted. It is NOT an
-- authorization input — what a key may do is its own `scope`. Mirrored on Node by the
-- `created_by_key_id` column on the Drizzle `public_api_keys` table.
ALTER TABLE public_api_keys ADD COLUMN created_by_key_id TEXT;
CREATE INDEX IF NOT EXISTS idx_public_api_keys_minter ON public_api_keys(created_by_key_id);
