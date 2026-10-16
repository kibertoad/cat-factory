// Persistence port for the self-hosted runner-pool integration. The worker
// implements this against D1 (migration 0013); tests can supply an in-memory
// fake. Rows are scoped by workspace, mirroring the environment-connection
// repository. The management-API secret bundle is stored as opaque ciphertext
// (see the SecretCipher port) — this record never holds plaintext secrets.

/**
 * A workspace's binding to an "agent runner backend" — the place repo-operating
 * coding jobs run. This generalises the original self-hosted runner pool into a
 * discriminated backend: `kind` selects WHICH backend (`manifest` = the BYO
 * scheduler HTTP pool, `kubernetes` = a native kube-apiserver pod runner, future
 * `nomad`/`eks`/…), and `configJson` carries that kind's serialized config (the
 * discriminated `RunnerBackendConfig`). The provider-registry seam in
 * `@cat-factory/integrations` maps `kind` → a `RunnerTransport`. The encrypted
 * per-tenant secret bundle (the backend's credentials — a scheduler API key, a
 * Kubernetes ServiceAccount token, …) is decrypted only in-memory, at call time,
 * by the dispatch/poll path.
 */
export interface RunnerPoolConnectionRecord {
  workspaceId: string
  /** Which runner backend this row configures (`manifest` | `kubernetes` | …). */
  kind: string
  providerId: string
  label: string
  /** The backend's primary URL (a manifest's `baseUrl`, a cluster's apiserver URL). */
  baseUrl: string
  /**
   * The serialized per-kind config: the discriminated `RunnerBackendConfig` JSON.
   * (Physical column keeps its historical `manifest_json` name — it now holds the
   * whole discriminated config, not just a manifest.)
   */
  configJson: string
  /** Ciphertext of the `{ key: value }` secret bundle (SecretCipher envelope). */
  secretsCipher: string
  createdAt: number
  /** Set when the workspace unregisters (tombstone). */
  deletedAt: number | null
}

export interface RunnerPoolConnectionRepository {
  /** The workspace's live connection, or null if not registered. */
  getByWorkspace(workspaceId: string): Promise<RunnerPoolConnectionRecord | null>
  /** Create or replace the live connection for a workspace. */
  upsert(record: RunnerPoolConnectionRecord): Promise<void>
  /** Tombstone the workspace's connection. */
  softDelete(workspaceId: string, at: number): Promise<void>
}

/**
 * An ACCOUNT's runner pool: the same shape as {@link RunnerPoolConnectionRecord}, keyed by account
 * instead of workspace. Every board of the account that has no live pool of its own (and has not
 * opted out through its `inheritAccountRunnerPool` setting) dispatches to it. One row per account,
 * with no tombstone: nothing unregisters it through the API, and a deployment's seed only ever
 * inserts it, so a deleted-but-present row would only add a state nobody reads.
 */
export interface AccountRunnerPoolRecord {
  accountId: string
  kind: string
  providerId: string
  label: string
  baseUrl: string
  /** The serialized discriminated `RunnerBackendConfig`. */
  configJson: string
  /** Ciphertext of the `{ key: value }` secret bundle (SecretCipher envelope). */
  secretsCipher: string
  createdAt: number
}

export interface AccountRunnerPoolRepository {
  getByAccount(accountId: string): Promise<AccountRunnerPoolRecord | null>
  /** The rows of the given accounts in one query; an account with none is absent. Empty in, empty out. */
  listByAccounts(accountIds: string[]): Promise<AccountRunnerPoolRecord[]>
  /**
   * Insert the account's pool unless it already has one, in one conflict-targeted statement (the
   * unique key on `account_id` is the arbiter, so two concurrent seeders cannot both win). Returns
   * whether THIS call inserted. An existing row is left untouched, whatever it holds.
   */
  insertIfAbsent(record: AccountRunnerPoolRecord): Promise<boolean>
}

/**
 * Ensures a deployment's DECLARED runner pool exists for an account: the runner-pool sibling of
 * `EnvironmentHandlerSeeder` and `SharedStackSeeder`, with the same two wiring sites (a boot
 * backfill, and `WorkspaceService.create`'s on-create hook), but keyed by ACCOUNT because that is
 * the scope a pool is inherited at. A seed never replaces a row the account already has, so a
 * second boot is a no-op.
 *
 * Kept free of integrations knowledge: the port speaks only ids; the concrete seeder (built over
 * `RunnerPoolConnectionService` and the deployment's seed callback) lives in
 * `@cat-factory/integrations`. Neither method throws: a failed seed is reported through the logger.
 */
export interface RunnerPoolSeeder {
  /** Seed the account's pool when it has none. A legacy board's `null` account is a no-op. */
  ensureForAccount(accountId: string | null): Promise<void>
  /** Seed every existing account that has no pool, over batch reads. */
  ensureForAllAccounts(): Promise<void>
}
