-- Flag a linked repo as a monorepo.
--
-- A monorepo-flagged repository can back more than one board service, each pinned to
-- its own subdirectory (see `services.directory`). This column was previously folded
-- inline into the squashed `0001_init.sql`, so existing databases that had already
-- applied `0001` never received it (the `PATCH /github/repos/:id` monorepo toggle then
-- 500s on `no such column: is_monorepo`). It now lives in this standalone migration so
-- it lands on every database; `0001` no longer creates the column.

ALTER TABLE github_repos ADD COLUMN is_monorepo INTEGER NOT NULL DEFAULT 0;
