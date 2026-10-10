-- Add a `provider` VCS discriminator to the GitHub-named projection tables so the SPA can
-- switch presentation (labels/icons/host+URL shapes) on github vs gitlab while the data
-- stays provider-neutral. The tables keep their GitHub names (the entity-rename fold is
-- separate, acknowledged Phase-1 work); the column value is the neutral VcsProvider.
-- A connection records its provider; the repos reached through it inherit it. Rows written
-- before this column default to 'github' — the only provider that populated these tables.
ALTER TABLE github_installations ADD COLUMN provider TEXT NOT NULL DEFAULT 'github';
ALTER TABLE github_repos ADD COLUMN provider TEXT NOT NULL DEFAULT 'github';
