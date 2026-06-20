-- Monorepo support: a linked repo may host more than one service, each pinned to a
-- subdirectory. `github_repos.is_monorepo` flags such a repo (board-owned, like
-- `block_id` — sync preserves it); `services.directory` records the subdirectory a
-- service lives in (NULL = the whole repo). The subdirectory is fed to every agent
-- working on the service when its repo is a monorepo.

ALTER TABLE github_repos ADD COLUMN is_monorepo INTEGER NOT NULL DEFAULT 0;
ALTER TABLE services ADD COLUMN directory TEXT;
