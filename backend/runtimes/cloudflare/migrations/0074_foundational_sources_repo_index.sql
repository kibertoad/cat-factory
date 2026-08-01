-- Push-webhook freshness fan-out for foundational-service sources
-- (backend/docs/adr/0031-foundational-services.md).
--
-- A push delivery names `owner/name` and nothing else, so the fan-out looks sources up by that
-- pair across EVERY tier. Without this index that read is a full scan on the hottest webhook
-- path in the deployment; with it, it is the same single indexed lookup `skill_sources` already
-- gets from `idx_skill_sources_repo` (migration 0052), which this mirrors.

CREATE INDEX idx_foundational_sources_repo
  ON foundational_service_sources (repo_owner, repo_name) WHERE deleted_at IS NULL;
