// Port for password hashing used by the email/password login provider. The facade
// supplies a Web Crypto implementation (PBKDF2-HMAC-SHA256 with a random per-record
// salt) that runs identically on Cloudflare workerd and Node — native argon2/bcrypt
// modules do NOT run in a Workers isolate, so the runtimes would diverge.
//
// `hash` returns a self-describing PHC-like string that embeds the algorithm,
// iteration count, and salt, so `verify` can re-derive without any external params.

export interface PasswordHasher {
  /** Hash a plaintext password, returning a self-describing PHC-like string. */
  hash(password: string): Promise<string>
  /** Constant-time verify a plaintext password against a stored hash. */
  verify(password: string, stored: string): Promise<boolean>
}
