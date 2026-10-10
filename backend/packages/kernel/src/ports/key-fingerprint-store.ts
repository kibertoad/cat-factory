// Port for the persisted, non-secret fingerprint of the deployment's master
// ENCRYPTION_KEY (ADR 0026 D6.1). The fingerprint is a one-way HKDF of the key
// (it leaks nothing usable — you cannot recover a 32-byte key from 8 bytes of HKDF
// output), persisted once on first boot. Every subsequent boot recomputes it from
// the current key and compares: a mismatch is an O(1), definitive "the key changed
// since secrets were last sealed" signal, available BEFORE any request touches a
// stale secret. A deployment-level singleton (one row), mirrored across runtimes.

export interface KeyFingerprintStore {
  /** The persisted fingerprint, or null when none has been recorded yet (first boot). */
  get(): Promise<string | null>
  /**
   * Persist the fingerprint. Called once on first boot to seed it; the boot check never
   * overwrites a mismatching value (that would erase the drift signal), so this is a
   * seed-once operation in practice.
   */
  set(fingerprint: string): Promise<void>
}
