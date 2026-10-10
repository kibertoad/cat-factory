// The durable auth-attempt ledger behind the password-endpoint throttle
// (SEC-4 / durable-auth-rate-limiting.md). The in-process Map it replaces was per
// isolate/replica, so the effective cap was `MAX_ATTEMPTS x nodes` and a rolling deploy
// reset it; this store is the cross-replica coordination point. Deliberately tiny: one
// append + two indexed range counts per password attempt (rare and PBKDF2-priced), and
// rows are junk minutes later, so the retention sweep prunes aggressively. Do NOT extend
// it to high-frequency routes: a general API rate limiter is a different design.

/** One recorded password attempt. */
export interface AuthAttemptRecord {
  /**
   * The throttle bucket, `<ip>:<email>` for the email endpoints and a fixed literal for
   * token-redeem (keying redeem by token value would hand every guess its own bucket).
   */
  key: string
  /** The resolved client IP, counted separately as the cross-email stuffing aggregate. */
  ip: string
  /** Epoch ms of the attempt. */
  at: number
}

export interface AuthAttemptRepository {
  /** Append one attempt. */
  record(attempt: AuthAttemptRecord): Promise<void>
  /** Attempts recorded for `key` at/after `sinceMs`. */
  countByKeySince(key: string, sinceMs: number): Promise<number>
  /**
   * Attempts recorded from `ip` at/after `sinceMs`, across every key: the aggregate
   * that stops one-password-many-emails credential stuffing, which the per-email key
   * alone cannot (each email gets a fresh bucket).
   */
  countByIpSince(ip: string, sinceMs: number): Promise<number>
  /** Retention: delete attempts recorded before `epochMs`; returns the count removed. */
  deleteOlderThan(epochMs: number): Promise<number>
}
