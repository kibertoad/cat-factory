-- Archive marker for a service frame. An archived service (`archived = 1`) is hidden from the
-- board projection along with its whole subtree, but every row is preserved so it can be
-- restored at any time with no expiry. This is the non-destructive alternative to deleting a
-- service that still has unfinished tasks. Mirrored on Node by the `archived` column on the
-- Drizzle `blocks` table.
ALTER TABLE blocks ADD COLUMN archived INTEGER;
