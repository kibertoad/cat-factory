import { PgBoss } from 'pg-boss'
import { checkKeyFingerprint, logger, requireEnv } from '@cat-factory/server'
import { describeError } from '@cat-factory/kernel'
import { createDbClient, type DrizzleDb } from './db/client.js'
import { loadNodeConfig } from './config.js'
import { migrate } from './db/migrate.js'
import { DrizzleKeyFingerprintStore } from './repositories/drizzle/settings.js'
import type { startBootClock } from './bootTimings.js'

// The persistence prologue of the Node boot, extracted from `bootServer` as a cohesive
// collaborator (the file-size ratchet: split, never grow). It is everything that must be true
// before a single service is constructed — the connection, the schema, the key-fingerprint drift
// check and a started pg-boss — and nothing that depends on the DI container. `bootServer` keeps
// the parts that thread its options through.

export interface PersistenceBoot {
  db: DrizzleDb
  pool: ReturnType<typeof createDbClient>['pool']
  boss: PgBoss
  /** The connection string, reused by the sibling pg-boss-adjacent wiring. */
  databaseUrl: string
  /** `DB_SCHEMA`, threaded into the repositories that qualify their tables explicitly. */
  dbSchema: string | undefined
  /** The trimmed `ENCRYPTION_KEY`, or undefined — the boot-time key-drift sweep needs it too. */
  encryptionKey: string | undefined
  /**
   * Whether pg-boss is still running, for the `/ready` probe. A closure rather than a boolean so
   * the caller reads the LIVE value — it flips when pg-boss emits `stopped` during shutdown.
   */
  isBossRunning: () => boolean
}

/**
 * Open the database, bring the schema up to date, verify the encryption key hasn't drifted, and
 * start pg-boss.
 *
 * Order is load-bearing: the config is validated first (it is pure, so a bad `ENCRYPTION_KEY`
 * surfaces before we open a connection or hammer Postgres on a restart loop), then migrations run
 * ALONE — a migration failure is then the clean top-level rejection the entrypoint reports, rather
 * than racing pg-boss's own schema provisioning inside a `Promise.all` (which would half-provision
 * pg-boss on a doomed boot and could mask the real error).
 */
export async function bootPersistence(
  env: NodeJS.ProcessEnv,
  bootClock: ReturnType<typeof startBootClock>,
): Promise<PersistenceBoot> {
  const databaseUrl = requireEnv(env, 'DATABASE_URL')
  // Validate the full config UP FRONT — it is pure (no I/O), so an ENCRYPTION_KEY / auth-provider
  // problem surfaces as a ConfigValidationError here, BEFORE we open a Postgres connection or run
  // migrations. Without this the same throw would fire deep inside `buildContainer` only after the
  // heavy DB boot, and a bad-config restart would needlessly hammer Postgres first.
  loadNodeConfig(env)
  bootClock.mark('config')
  // Optional schema overrides for a SHARED database (where `public` is unavailable, or another
  // service already owns the default `drizzle`/`pgboss` schemas). All default to the prior
  // behaviour, so a stock deployment is unchanged:
  //   - DB_SCHEMA — the default (`public`) app tables, relocated via the connection search_path.
  //   - DB_MIGRATIONS_SCHEMA — the drizzle migration ledger (`drizzle`), so cat-factory's ledger
  //     can't collide with another drizzle-using service's `drizzle.__drizzle_migrations`.
  //   - DB_PGBOSS_SCHEMA — pg-boss's queue schema (`pgboss`).
  // The named app schemas (telemetry/sandbox/provisioning) are always explicitly qualified and
  // unaffected.
  const dbSchema = env.DB_SCHEMA
  const migrationsSchema = env.DB_MIGRATIONS_SCHEMA
  const { db, pool } = createDbClient(databaseUrl, dbSchema)
  const boss = new PgBoss({
    connectionString: databaseUrl,
    // Default (`pgboss`) when unset — a single object literal (not a string|object union) so it
    // resolves to pg-boss's options-constructor overload.
    ...(env.DB_PGBOSS_SCHEMA?.trim() ? { schema: env.DB_PGBOSS_SCHEMA.trim() } : {}),
  })
  // `migrate()` throws a MigrationFailedError / DbSchemaInconsistentError with a recovery hint
  // when the DB is wedged.
  await migrate(db, pool, { schema: dbSchema, migrationsSchema, databaseUrl })
  bootClock.mark('migrate')
  // ADR 0026 D6.1: an O(1) ENCRYPTION_KEY drift check, right after the schema is up (the
  // `key_fingerprint` table exists) and before any request/run touches a stale secret. It
  // seeds the fingerprint on first boot and logs a definitive drift signal on a key change.
  // Best-effort: wrapped so a store hiccup logs and never blocks boot.
  const encryptionKey = env.ENCRYPTION_KEY?.trim()
  if (encryptionKey) {
    await checkKeyFingerprint({
      store: new DrizzleKeyFingerprintStore(db),
      masterKeyBase64: encryptionKey,
      logger: logger.child({ boot: 'key-fingerprint' }),
    }).catch((error: unknown) => logger.warn('key fingerprint check failed', describeError(error)))
  }
  await boss.start()
  bootClock.mark('bossStart')
  // pg-boss lifecycle flags for the `/ready` probe: it's running once `start()` resolves and stops
  // being ready when it emits `stopped` (graceful shutdown) or `draining` flips at SIGTERM. The
  // pool's own health is probed live per request (a `SELECT 1`), so it needs no flag.
  // NOTE: this tracks the GRACEFUL `stopped` transition only — a boss that crashes/wedges without
  // emitting `stopped` still reads healthy here. That's an accepted residual gap: such an outage is
  // almost always a shared-database failure the live `SELECT 1` probe catches, and flipping the
  // flag off every transient `error` event would drain the replica on recoverable blips.
  let bossRunning = true
  boss.on('stopped', () => {
    bossRunning = false
  })
  // pg-boss is an EventEmitter, and an unhandled `'error'` event on one THROWS — so a
  // maintenance-loop hiccup could take the orchestrator down with no log line naming pg-boss.
  // Subscribing turns that into a warning and leaves the readiness flag alone: `error` covers
  // recoverable blips as well as fatal ones, and draining the replica on every one of them
  // would be worse than the blip (see the note above `bossRunning`).
  boss.on('error', (error: unknown) => {
    logger.warn('pg-boss emitted an error event', describeError(error))
  })

  return {
    db,
    pool,
    boss,
    databaseUrl,
    dbSchema,
    encryptionKey,
    isBossRunning: () => bossRunning,
  }
}
