// Persistence port for password-reset tokens — the "forgot my password" flow. A user
// requests a reset; an opaque token (delivered by email) is redeemed to set a new
// password. Only the token's SHA-256 HASH is stored, never the raw token — the raw
// value lives only in the emailed link. Single-use (status flips to `used`) and
// expiring. Mirrored on both runtimes (D1 ⇄ Drizzle).

export type PasswordResetTokenStatus = 'pending' | 'used'

export interface PasswordResetTokenRecord {
  id: string
  /** The user whose password this token resets. */
  userId: string
  /** SHA-256 hash (hex) of the opaque token; the raw token is never stored. */
  tokenHash: string
  status: PasswordResetTokenStatus
  expiresAt: number
  createdAt: number
}

export interface PasswordResetTokenRepository {
  create(record: PasswordResetTokenRecord): Promise<void>
  /** Resolve a token by its hash (the redeem path); null when unknown. */
  findByTokenHash(tokenHash: string): Promise<PasswordResetTokenRecord | null>
  /** Every still-pending token for a user (used to supersede on mint/redeem). */
  listPendingByUser(userId: string): Promise<PasswordResetTokenRecord[]>
  /** Flip a token's status (supersede a still-live token on mint/redeem). */
  setStatus(id: string, status: PasswordResetTokenStatus): Promise<void>
  /**
   * Atomically consume a token: flip `pending` → `used` and report whether THIS call
   * performed the transition. The single-use guard — two concurrent redemptions of the
   * same token race here, and only the winner gets `true`, so the password is set exactly
   * once. A token that is already `used` (or gone) yields `false`.
   */
  consume(id: string): Promise<boolean>
  /** Purge tokens whose `expiresAt` is before `before`; returns the count removed. */
  deleteExpired(before: number): Promise<number>
}
