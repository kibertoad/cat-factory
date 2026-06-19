-- Storage & data-retention follow-ups (see docs/storage-and-retention.md).
--
-- The unbounded ledgers already have the indexes their retention sweeps need:
-- token_usage.idx_token_usage_created (created_at) and
-- github_rate_limits.idx_gh_ratelimit_observed (observed_at). github_commits is
-- the one append-only projection without a column the retention pass can scan, so
-- add an index on authored_at to keep the periodic `DELETE … WHERE authored_at <
-- horizon` cheap (and bounded by the rows actually being reclaimed).

CREATE INDEX idx_gh_commits_authored ON github_commits (authored_at);
