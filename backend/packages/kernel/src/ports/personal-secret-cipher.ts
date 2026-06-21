// Port for the SECOND, password-derived encryption layer used by individual-usage
// subscriptions. Distinct from {@link SecretCipher} (the system layer): this seals a
// plaintext under a key derived from the user's PERSONAL PASSWORD, which is never
// stored. The facade supplies a Web Crypto implementation (PBKDF2 → AES-256-GCM) with
// a self-describing envelope that embeds the per-record salt + IV.
//
// `open` throws when the password is wrong (the AEAD auth check fails and a magic
// header mismatch is detected), which the service maps to a `wrong_password`
// credential-required error. The system layer is applied on top of this envelope so
// the at-rest credential needs BOTH the system key AND the user's password to recover.

export interface PersonalSecretCipher {
  /** Seal plaintext under a key derived from `password`, returning an opaque envelope. */
  seal(plaintext: string, password: string): Promise<string>
  /** Open an envelope produced by {@link seal}; throws if `password` is wrong/tampered. */
  open(envelope: string, password: string): Promise<string>
}
