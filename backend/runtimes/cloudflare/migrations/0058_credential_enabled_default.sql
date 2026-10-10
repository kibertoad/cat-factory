-- Enable/disable + pinned default for the two credential pools (subscription tokens and
-- direct-provider API keys). A pool can hold several credentials "for the same thing"
-- (a vendor / a scope+provider); these flags let an operator take one out of rotation
-- without deleting it, and pin one as the preferred credential.
--
-- `enabled`    — 1 (default) ⇒ eligible for leasing. 0 ⇒ kept in the pool (still listed and
--                re-enablable) but never leased and not counted as "configured".
-- `is_default` — 0 (default) ⇒ ordinary usage-aware rotation. 1 ⇒ the pinned default for its
--                group (workspace+vendor / scope+scope_id+provider): leased first when enabled.
--                At most one per group is enforced by the write path (set-default clears the
--                group's other flags first). A disabled default is ignored at lease time.
--
-- Existing rows read unchanged (enabled, not default) — pre-1.0, no back-fill needed.

ALTER TABLE provider_subscription_tokens ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE provider_subscription_tokens ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0;

ALTER TABLE provider_api_keys ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE provider_api_keys ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0;
