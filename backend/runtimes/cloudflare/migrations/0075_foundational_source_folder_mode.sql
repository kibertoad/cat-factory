-- `folder`-mode foundational-service sources
-- (backend/docs/adr/0031-foundational-services.md).
--
-- A third source shape: the WHOLE of `dir_path` — optionally including its subfolders — is the
-- contract set of the ONE service the link names. `mode` carries no CHECK constraint, so the new
-- value needs no schema change; what it needs is somewhere to record whether the scan descends.
--
-- Default 0, which is the only value every existing row can honestly take: `directory` mode's
-- subdirectories ARE its services and `files` mode enumerates its paths, so neither walks a
-- subtree for one service's contracts and neither is affected by this column.

ALTER TABLE foundational_service_sources
  ADD COLUMN recursive INTEGER NOT NULL DEFAULT 0;
