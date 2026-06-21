-- "Notify the task creator" routing: record who created a block (a task today) as
-- the GitHub user id from the authenticated session at creation. Nullable — legacy
-- blocks and the auth-disabled/local-dev path (no user) carry no creator, and the
-- notification mention logic simply skips a creator it can't resolve.
ALTER TABLE blocks ADD COLUMN created_by INTEGER;
