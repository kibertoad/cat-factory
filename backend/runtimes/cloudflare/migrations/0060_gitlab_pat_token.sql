-- A durable, sealed access credential on a workspace's VCS connection, for the per-workspace
-- PAT connect flow (a hosted GitLab connect seals the user's PAT here, sealed with the
-- deployment SecretCipher — never plaintext). Null for the GitHub-App path, which mints its
-- own tokens and caches them in `cached_token`. See kernel `GitHubInstallation.accessToken`.
ALTER TABLE github_installations ADD COLUMN access_token TEXT;
