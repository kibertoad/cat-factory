// Port for authenticated encryption of credentials at rest. The core depends
// only on this interface; the worker supplies a Web Crypto (AES-256-GCM)
// implementation keyed by a service-level master secret. Used to protect the
// per-tenant management-API secret bundle and the per-environment access creds
// before they are written to D1, and to decrypt them in-memory at call time.

export interface SecretCipher {
  /** Encrypt plaintext into an opaque, self-describing envelope string. */
  encrypt(plaintext: string): Promise<string>
  /** Decrypt an envelope produced by {@link encrypt}. Throws if tampered/invalid. */
  decrypt(envelope: string): Promise<string>
}
