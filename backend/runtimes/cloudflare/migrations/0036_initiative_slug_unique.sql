-- The initiative tracker folder `docs/initiatives/<slug>/` is keyed by slug, so a slug
-- must be unique per workspace. This backstops the read-then-insert slug derivation in
-- InitiativeService.create against a concurrent same-title race: the losing insert fails
-- rather than silently sharing a tracker folder with the winner. Mirror of the Drizzle
-- `idx_initiatives_slug` unique index.
CREATE UNIQUE INDEX idx_initiatives_slug ON initiatives (workspace_id, slug);
