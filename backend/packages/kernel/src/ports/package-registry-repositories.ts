// Persistence port for the private package-registry integration (npm private orgs,
// GitHub Packages). Mirrors across the D1 (Cloudflare) and Drizzle/Postgres (Node)
// facades (runtime parity is mandatory). Tokens are sealed at rest by the facade's
// SecretCipher; the record carries the sealed blob (never plaintext) plus a
// non-secret summary. Modelled on ObservabilityConnectionRepository.

/** A workspace's package-registry connection. Exactly one row per workspace. */
export interface PackageRegistryConnectionRecord {
  workspaceId: string
  /**
   * Sealed (by the facade SecretCipher) JSON array of registry entries —
   * `[{ id, ecosystem, vendor, scopes, token }]`. Opaque to everything but the
   * package-registry service, which decrypts it at dispatch time.
   */
  entries: string
  /**
   * Non-secret display summary as a JSON array (`[{ id, ecosystem, vendor, scopes,
   * tokenTail }]`), so the list view renders without ever decrypting the tokens.
   */
  summary: string
  createdAt: number
  updatedAt: number
}

export interface PackageRegistryConnectionRepository {
  get(workspaceId: string): Promise<PackageRegistryConnectionRecord | null>
  upsert(record: PackageRegistryConnectionRecord): Promise<void>
  delete(workspaceId: string): Promise<void>
}
