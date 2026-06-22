// Port for transactional email delivery (invitations today; could back an email
// NotificationChannel later). The facade composes whichever provider is configured
// (SendGrid / Resend) behind this single port — mirroring how the model registry
// composes vendor resolvers. Unconfigured ⇒ the port is simply not wired, and the
// callers that need it are opt-in.

export interface EmailMessage {
  to: string
  subject: string
  /** HTML body. */
  html: string
  /** Plain-text fallback (recommended for deliverability). */
  text?: string
}

export interface EmailSender {
  /** Send one transactional email. Throws on a provider/transport failure. */
  send(message: EmailMessage): Promise<void>
}

/** Supported transactional-email providers (UI-onboarded per account). */
export type EmailProviderKind = 'sendgrid' | 'resend'

/**
 * An account's email-sender connection: which provider, the From address, and the
 * encrypted provider API key. Keyed per-account and stored in the DB (onboarded in
 * the UI, never via env). The key is decrypted only in-memory at send time.
 */
export interface EmailConnectionRecord {
  accountId: string
  provider: EmailProviderKind
  fromAddress: string
  /** Ciphertext of the provider API key (SecretCipher envelope); never plaintext. */
  apiKeyCipher: string
  createdAt: number
  updatedAt: number
  /** Set when the account disconnects email (tombstone). */
  deletedAt: number | null
}

export interface EmailConnectionRepository {
  /**
   * The account's live (non-tombstoned) connection, or null when not connected or
   * disconnected. Soft-deleted rows are filtered out, so callers never see a tombstone.
   */
  getByAccount(accountId: string): Promise<EmailConnectionRecord | null>
  /** Create or replace the live connection for an account. */
  upsert(record: EmailConnectionRecord): Promise<void>
  /** Tombstone the account's connection. */
  softDelete(accountId: string, at: number): Promise<void>
}
