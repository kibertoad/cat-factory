-- Local-mode infrastructure delegation opt-ins (per workspace). By default local mode
-- runs everything on the host container runtime (container agents on host Docker, the
-- Tester's infra via in-container docker-compose / DinD). These two toggles let a
-- developer delegate either concern to an external service instead: container agents to
-- the workspace's registered self-hosted runner pool, and/or the Tester's ephemeral
-- environments to the registered environment provider. Off by default (0); inert on the
-- Cloudflare/Node facades (their agent backend is fixed). Mirrors the Drizzle
-- `delegate_agents_to_runner_pool` / `delegate_test_env_to_provider` columns on
-- workspace_settings (integer 0/1).
ALTER TABLE workspace_settings ADD COLUMN delegate_agents_to_runner_pool INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workspace_settings ADD COLUMN delegate_test_env_to_provider INTEGER NOT NULL DEFAULT 0;
