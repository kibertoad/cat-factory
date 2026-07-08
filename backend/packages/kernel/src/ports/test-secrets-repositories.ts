// Persistence port for the SENSITIVE per-service test credentials (a third-party API token
// the Tester needs). Mirrors across the D1 (Cloudflare) and Drizzle/Postgres (Node) facades
// (runtime parity is mandatory). The values are sealed at rest by the facade's SecretCipher
// (info tag `cat-factory:test-secrets`); the record here carries the sealed blob (never
// plaintext) plus a non-secret summary (the keys + descriptions) so a view/prompt can list
// what is configured without decrypting anything.
//
// Keyed by the SERVICE FRAME block, exactly like `release_health_configs`: the engine resolves
// a run's service frame and reads the secrets mapped to it (walking up the frame chain). This
// is the SEALED sibling of the non-sensitive `ServiceTestCredentials` pools — see
// docs/initiatives/tester-environment-access.md.

/** A service frame's sensitive test-secret set. At most one row per (workspace, block). */
export interface TestSecretRecord {
  workspaceId: string
  /** The service frame block these secrets belong to. */
  blockId: string
  /**
   * Sealed (by the facade SecretCipher) JSON of the full `TestSecretEntry[]` — each
   * `{ key, description, value }`. Opaque to everything but the service, which decrypts it at
   * dispatch time to inject the values into the Tester container.
   */
  credentials: string
  /**
   * Non-secret display summary as JSON: the `TestSecretRef[]` (each `{ key, description }`), so
   * the view + the tester prompt can list what is configured without ever decrypting a value.
   */
  summary: string
  createdAt: number
  updatedAt: number
}

export interface TestSecretsRepository {
  getByBlock(workspaceId: string, blockId: string): Promise<TestSecretRecord | null>
  listByWorkspace(workspaceId: string): Promise<TestSecretRecord[]>
  upsert(record: TestSecretRecord): Promise<void>
  deleteByBlock(workspaceId: string, blockId: string): Promise<void>
}
