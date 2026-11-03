-- A personal key whose reach is its bound person's workspaces, decided on each call rather than
-- granted (backend/docs/public-api.md, "Keys that follow your workspaces"). Such a key has no rows
-- in `public_api_key_workspaces` and `all_workspaces = 0`, so a reader that ignores this column sees
-- a key reaching nothing rather than one reaching more. Set only with `acts_as_user_id`. Mirrored on
-- Node by the `follows_memberships` column on the Drizzle `public_api_keys` table.
ALTER TABLE public_api_keys ADD COLUMN follows_memberships INTEGER NOT NULL DEFAULT 0;
