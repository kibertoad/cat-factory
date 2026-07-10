---
'@cat-factory/node-server': patch
'@cat-factory/local-server': patch
'@cat-factory/worker': patch
---

Make database migrations fail safe and recover cleanly.

Motivated by a `0.63 → 0.64` upgrade that bricked boot: a database whose drizzle-kit 1.0
migration ledger (in its own `drizzle` schema) had outlived its `public` tables — the classic
ledger↔schema split left by a hand `DROP SCHEMA public CASCADE` — hit a bare
`42P01 relation "accounts" does not exist` deep inside the new FK migration, with no
remediation path.

- **Boot drift-guard + wrapped errors (Node).** `migrate()` now probes for the ledger↔schema
  split up front (ledger non-empty but anchor tables `public.accounts`/`public.workspaces`
  missing) and throws a clear `DbSchemaInconsistentError`, and wraps any apply failure in a
  `MigrationFailedError` mapping the pg code (`42P01`/`23503`/`42P07`) to a human cause + the
  recovery command. Boot runs `migrate()` before `boss.start()` (no longer racing them in a
  `Promise.all`) so the migration error is the clean top-level rejection.
- **`db:reset` recovery command (Node).** `pnpm --filter @cat-factory/node-server db:reset`
  drops all app-owned schemas together — the app schema, `telemetry`, `sandbox`,
  `provisioning`, the migration ledger, and pg-boss's queue schema — so the ledger can never
  outlive the data. This is the sanctioned recovery; never hand-drop `public` alone (that is
  what causes the split). **DESTRUCTIVE** — it deletes all data in `DATABASE_URL`.
- **Configurable schemas for a shared database (Node).** New optional env vars, all defaulting
  to the prior behaviour: `DB_SCHEMA` relocates the default (`public`) app tables via the
  connection `search_path` (for databases with no usable `public`); `DB_MIGRATIONS_SCHEMA` moves
  the drizzle migration ledger off the top-level `drizzle` schema so it can't collide with
  another drizzle-using service's `drizzle.__drizzle_migrations`; `DB_PGBOSS_SCHEMA` moves
  pg-boss's queue schema. `db:reset` honours the same vars. The named app schemas
  (`telemetry`/`sandbox`/`provisioning`) remain fixed.
- **Self-healing FK migrations (both runtimes).** The `ON DELETE RESTRICT` FK migrations now
  delete/NULL pre-existing orphans before `ADD CONSTRAINT`, so a database old enough to predate
  the FKs migrates instead of hard-failing on `23503`. Applied symmetrically to the Postgres
  `20260709061125_old_santa_claus` migration and the D1
  `0046_user_identity_foreign_keys.sql` rebuild. **Breaking:** editing these already-shipped
  migrations changes their content; a database that already applied the originals should recover
  via `db:reset` (only experimental installs exist pre-1.0). Orphaned rows are deleted — losing
  that stale data is acceptable (backwards compatibility is a non-goal).
- **Test-pollution hardening.** The Node/local/mothership test harnesses now require a
  per-vitest-worker database (they refuse to run against the base `DATABASE_URL`) and use the
  `postgres` maintenance database for the admin `CREATE DATABASE` connection, so running the
  suite can never pollute or desync a developer's dev database.
