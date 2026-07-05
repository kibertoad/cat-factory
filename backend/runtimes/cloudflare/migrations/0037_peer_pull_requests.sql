-- Multi-repo coding (phase 3 of the service-connections initiative): the PRs the
-- implementer opened in connected services' repos, beside the own-service `pull_request`.
-- Serialized JSON array of { repo, frameId?, ref }. Engine-written, never client-patchable.
ALTER TABLE blocks ADD COLUMN peer_pull_requests TEXT;
