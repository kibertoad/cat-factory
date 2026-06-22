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
