import { applyD1Migrations, env } from 'cloudflare:test'

// Runs once per test file before its tests: applies the real D1 migrations to
// the isolated local database, so every test exercises the true schema.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
// The dedicated telemetry database (llm_call_metrics + agent_context_snapshots).
await applyD1Migrations(env.TELEMETRY_DB, env.TEST_TELEMETRY_MIGRATIONS)
