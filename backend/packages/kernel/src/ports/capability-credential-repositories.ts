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
  /**
   * Optimistic-concurrency revision, bumped on every write. The row is ONE sealed blob, so the
   * per-key writes are read-modify-write over the whole set; the rev is what keeps two operators
   * saving DIFFERENT keys from silently destroying each other's (the loser's save returned
   * success, so nothing would ever look wrong).
   */
  rev: number
  createdAt: number
  updatedAt: number
}

export interface CapabilityCredentialRepository {
  get(workspaceId: string): Promise<CapabilityCredentialRecord | null>
  /**
   * Blind whole-set write (the set-replacing PUT, whose semantics ARE last-writer-wins). Inserts
   * with the record's `rev`; on conflict the STORED rev is bumped in SQL (the record's is
   * ignored), so the rev stays monotonic under blind writes and a concurrent `compareAndSwap`
   * whose base predates this write reliably loses.
   */
  upsert(record: CapabilityCredentialRecord): Promise<void>
  /**
   * Rev-guarded conditional write for the read-modify-write paths (the per-key put/remove):
   * persists `record` (with `record.rev` already bumped by the caller) ONLY if the stored row
   * still carries `expectedRev`. `expectedRev: null` means "expect NO row": a
   * conflict-do-nothing insert, false when a concurrent writer created one. False ⇒ the caller
   * reloads and re-applies on the winner's snapshot.
   */
  compareAndSwap(record: CapabilityCredentialRecord, expectedRev: number | null): Promise<boolean>
  /**
   * Rev-guarded delete (a per-key remove that empties the set). False when another writer moved
   * the row first: their write may have added the key back.
   */
  deleteIfRev(workspaceId: string, expectedRev: number): Promise<boolean>
  /** Blind delete: the whole-set PUT of an empty set, which clears the row by intent. */
  delete(workspaceId: string): Promise<void>
}
