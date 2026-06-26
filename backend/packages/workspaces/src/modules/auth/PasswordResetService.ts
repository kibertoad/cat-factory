import { ConflictError, NotFoundError, ValidationError } from '@cat-factory/kernel'
import type {
  Clock,
  EmailSender,
  IdGenerator,
  PasswordHasher,
  PasswordResetTokenRecord,
  PasswordResetTokenRepository,
  UserRepository,
} from '@cat-factory/kernel'

// ---------------------------------------------------------------------------
// PasswordResetService: the "forgot my password" flow for password-based logins.
// A user requests a reset by email; an opaque token (delivered by email) is redeemed
// to set a new password. Only the token's SHA-256 hash is stored — the raw token lives
// only in the emailed link. Mirrors InvitationService (token minting + hash storage +
// EmailSender delivery), and reuses the PasswordHasher exactly as UserService does.
//
// Security: the request path never reveals whether an email is registered (it returns
// the same way for a hit and a miss — the controller always responds generically), the
// raw token is never returned over HTTP, tokens are single-use + short-lived, and a
// successful reset (or a fresh request) supersedes every other pending token.
// ---------------------------------------------------------------------------

const RESET_TTL_MS = 60 * 60 * 1000

/** Minimal structural logger (satisfied by the facade's pino logger) — kept local so
 * this base-layer package doesn't depend on the server layer. */
export interface ResetLogger {
  info(obj: Record<string, unknown>, msg?: string): void
}

export interface PasswordResetServiceDependencies {
  passwordResetTokenRepository: PasswordResetTokenRepository
  userRepository: UserRepository
  passwordHasher: PasswordHasher
  idGenerator: IdGenerator
  clock: Clock
  /**
   * Resolve the deployment's system email sender at send time. Absent / returning null
   * ⇒ no email is sent; the reset link is logged (dev convenience) instead, never
   * returned to the caller.
   */
  resolveSystemEmailSender?: () => Promise<EmailSender | null>
  /** Public base URL the reset link points at (the SPA origin). */
  appBaseUrl?: string
  logger?: ResetLogger
}

/** SHA-256 hex digest — Web Crypto, runs on both runtimes. */
async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export class PasswordResetService {
  constructor(private readonly deps: PasswordResetServiceDependencies) {}

  /**
   * Request a password reset for `email`. No-op (silent) when no password identity owns
   * the email — the caller must respond identically regardless so the endpoint can't be
   * used to enumerate registered emails. Mints a single-use token (superseding any prior
   * pending ones) and emails the reset link; when no sender is configured the link is
   * logged for local/dev testing rather than returned.
   */
  async request(email: string): Promise<void> {
    const normalizedEmail = email.toLowerCase().trim()
    if (!normalizedEmail) return
    // Only password-based logins can reset a password (OAuth-only users have no secret).
    const identity = await this.deps.userRepository.getIdentity('password', normalizedEmail)
    if (!identity?.secret) return

    // Supersede any still-pending token so only the freshly-minted one stays live.
    const pending = await this.deps.passwordResetTokenRepository.listPendingByUser(identity.userId)
    for (const prior of pending) {
      await this.deps.passwordResetTokenRepository.setStatus(prior.id, 'used')
    }

    const token = `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, '')
    const record: PasswordResetTokenRecord = {
      id: this.deps.idGenerator.next('prt'),
      userId: identity.userId,
      tokenHash: await sha256Hex(token),
      status: 'pending',
      expiresAt: this.deps.clock.now() + RESET_TTL_MS,
      createdAt: this.deps.clock.now(),
    }
    await this.deps.passwordResetTokenRepository.create(record)

    const resetUrl = this.deps.appBaseUrl
      ? `${this.deps.appBaseUrl.replace(/\/$/, '')}/reset-password?token=${token}`
      : null
    const sender = this.deps.resolveSystemEmailSender
      ? await this.deps.resolveSystemEmailSender()
      : null
    if (sender && resetUrl) {
      await sender.send({
        to: normalizedEmail,
        subject: 'Reset your Cat Factory password',
        text: `Reset your password using this link (valid for 1 hour): ${resetUrl}`,
        html: resetEmailHtml(resetUrl),
      })
    } else if (resetUrl) {
      // No system sender configured: surface the link in the logs so local/dev can test.
      // It is NEVER returned to the unauthenticated caller.
      this.deps.logger?.info(
        { resetUrl, userId: identity.userId },
        'Password reset requested but no email sender configured; link logged for dev',
      )
    }
  }

  /**
   * Redeem a reset token and set the user's new password. Throws on a missing / already-
   * used / expired token (the controller maps these to a generic 400). On success the
   * password identity's secret is replaced, the token is consumed, and every other
   * pending token for the user is superseded.
   */
  async reset(token: string, newPassword: string): Promise<void> {
    if (newPassword.length < 8) {
      throw new ValidationError('Password must be at least 8 characters')
    }
    const record = await this.deps.passwordResetTokenRepository.findByTokenHash(
      await sha256Hex(token),
    )
    if (!record || record.status !== 'pending') {
      throw new NotFoundError('PasswordResetToken', 'token')
    }
    if (record.expiresAt < this.deps.clock.now()) {
      throw new ConflictError('This password reset link has expired')
    }
    const user = await this.deps.userRepository.get(record.userId)
    if (!user?.email) {
      // The token references a user with no resettable email identity — treat as invalid.
      throw new NotFoundError('PasswordResetToken', 'token')
    }
    const identity = await this.deps.userRepository.getIdentity('password', user.email)
    if (!identity) throw new NotFoundError('PasswordResetToken', 'token')

    // Replace the secret in place (idempotent on `(provider, subject)`, exactly like the
    // rehash-on-login path in UserService).
    await this.deps.userRepository.linkIdentity({
      ...identity,
      secret: await this.deps.passwordHasher.hash(newPassword),
    })
    await this.deps.passwordResetTokenRepository.setStatus(record.id, 'used')
    // Invalidate any other live tokens for this user — the password is now changed.
    const pending = await this.deps.passwordResetTokenRepository.listPendingByUser(record.userId)
    for (const other of pending) {
      if (other.id !== record.id) {
        await this.deps.passwordResetTokenRepository.setStatus(other.id, 'used')
      }
    }
  }
}

function resetEmailHtml(resetUrl: string): string {
  return `<!doctype html><html><body style="font-family:sans-serif">
<h2>Reset your password</h2>
<p>We received a request to reset your Cat Factory password. This link is valid for 1 hour.</p>
<p><a href="${resetUrl}" style="display:inline-block;padding:10px 18px;background:#111;color:#fff;border-radius:6px;text-decoration:none">Reset password</a></p>
<p>Or paste this link into your browser:<br>${resetUrl}</p>
<p>If you didn't request this, you can safely ignore this email.</p>
</body></html>`
}
