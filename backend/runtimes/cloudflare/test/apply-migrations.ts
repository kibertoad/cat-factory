import { applyD1Migrations, env } from 'cloudflare:test'

// Runs once per test file before its tests: applies the real D1 migrations to
// the isolated local databases, so every test exercises the true schema.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
// The dedicated telemetry database (llm_call_metrics + agent_context_snapshots).
await applyD1Migrations(env.TELEMETRY_DB, env.TEST_TELEMETRY_MIGRATIONS)
// The Sandbox lives in its own D1 database (SANDBOX_DB), with its own migrations.
// Always bound in the test wrangler.toml (optional only in production).
await applyD1Migrations(env.SANDBOX_DB!, env.TEST_SANDBOX_MIGRATIONS)
