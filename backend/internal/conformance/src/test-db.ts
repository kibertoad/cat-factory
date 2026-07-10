// Per-vitest-worker database isolation for the Postgres-backed runtime suites.
//
// The Node + Local conformance/integration suites used to run serially
// (`fileParallelism: false`) because every spec file shared the ONE database named in
// `DATABASE_URL`, with isolation only at the application level (per-test workspace UUIDs).
// Concurrent files would then race on the shared tables. Giving each vitest worker its
// own database lets the suites run with file parallelism: files on different workers
// touch different databases, and files on the same worker still run sequentially.
//
// This module is the pure (no-`pg`, no-`process`) half: it derives the per-worker database
// name + URL from `DATABASE_URL` and the worker id vitest sets (`VITEST_WORKER_ID`, passed
// in by the caller so this stays runtime-neutral). The harness does the actual
// `CREATE DATABASE` over its own pooled client.

/** The per-worker database name + connection URL derived from a base `DATABASE_URL`. */
export interface WorkerDatabase {
  /** The sanitised database name (safe to interpolate into `CREATE DATABASE`). */
  dbName: string
  /** `baseUrl` with its path swapped to the per-worker database. */
  url: string
}

/**
 * Derive a per-worker database for `label` (the runtime, e.g. `node` / `local` — included
 * so the Node and Local suites never collide on a shared Postgres server) from `baseUrl`
 * and `workerId` (vitest's `VITEST_WORKER_ID`, read by the caller). Returns `null` when no
 * worker id is set (e.g. a single-worker run or a non-vitest caller), so the caller falls
 * back to the base URL unchanged.
 */
export function deriveWorkerDatabase(
  baseUrl: string,
  label: string,
  workerId: string | undefined,
): WorkerDatabase | null {
  if (!workerId) return null
  const parsed = new URL(baseUrl)
  const sanitize = (s: string): string => s.toLowerCase().replace(/[^a-z0-9_]/g, '_')
  const baseName = sanitize(parsed.pathname.replace(/^\//, '') || 'postgres')
  // Postgres identifiers are case-folded and have a 63-byte limit. The `_${label}_${workerId}`
  // suffix is what keeps distinct workers (and runtimes) apart, so truncate the BASE NAME to
  // fit and always append the full suffix — truncating the whole string instead would chop
  // off the disambiguator and let long base names collide distinct workers onto one database.
  const suffix = `_${sanitize(label)}_${sanitize(workerId)}`
  const dbName = `${baseName.slice(0, Math.max(0, 63 - suffix.length))}${suffix}`
  parsed.pathname = `/${dbName}`
  return { dbName, url: parsed.toString() }
}

/**
 * The admin connection URL for `CREATE DATABASE` / `pg_database` probes: `baseUrl` with its
 * path swapped to the `postgres` maintenance database (which always exists). `CREATE DATABASE`
 * needs a connection to SOME existing database; using the maintenance DB rather than the app's
 * base database keeps a test run from ever opening a pool on — let alone mutating — the
 * developer's `DATABASE_URL` database.
 */
export function adminDatabaseUrl(baseUrl: string): string {
  const parsed = new URL(baseUrl)
  parsed.pathname = '/postgres'
  return parsed.toString()
}
