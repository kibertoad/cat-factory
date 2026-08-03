// Persistence port for the PER-WORKSPACE capability credentials — the secrets a registered
// capability (a tool server, a generative binary integration) declares by name.
//
// Mirrors across the D1 (Cloudflare) and Drizzle/Postgres (Node) facades; runtime parity is
// mandatory. Values are sealed at rest by the facade's `SecretCipher` (info tag
// `cat-factory:capability-credentials`), so the record here carries the sealed blob and never
// plaintext — which is also what lets it ride the mothership's persistence RPC, exactly like
// `TestSecretsRepository`.
//
// ONE ROW PER WORKSPACE, holding the whole set, rather than a row per key. The read is on the
// dispatch path (every container job with a declared capability), the set is small and bounded,
// and the whole set is what both the resolver and the UI want — so a row per key would buy a
// finer write at the cost of turning one read into N and one sealed blob into N.

/** A workspace's sealed capability-credential set. At most one row per workspace. */
export interface CapabilityCredentialRecord {
  workspaceId: string
  /**
   * Sealed JSON of the full `CapabilityCredentialEntry[]` — each `{ key, value }`. Opaque to
   * everything but the service, which decrypts it at dispatch to answer a resolver lookup.
   */
  credentials: string
  /**
   * Non-secret display summary as JSON: the `CapabilityCredentialRef[]` (each `{ key,
   * updatedAt }`), so the settings view can list what is configured without decrypting anything.
   */
  summary: string
  createdAt: number
  updatedAt: number
}

export interface CapabilityCredentialRepository {
  get(workspaceId: string): Promise<CapabilityCredentialRecord | null>
  upsert(record: CapabilityCredentialRecord): Promise<void>
  delete(workspaceId: string): Promise<void>
}
