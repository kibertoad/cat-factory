import type {
  Clock,
  EmailConnectionRecord,
  EmailConnectionRepository,
  EmailMessage,
  EmailProviderKind,
  EmailSender,
  SecretCipher,
} from '@cat-factory/kernel'
import { ValidationError } from '@cat-factory/kernel'
import { createEmailSender } from './adapters.js'

// EmailConnectionService: owns each ACCOUNT's transactional-email sender (SendGrid /
// Resend) — the provider, From address, and the encrypted API key. Mirrors
// SlackConnectionService: account-scoped, the secret is sealed at rest (SecretCipher)
// and decrypted only in-memory at send time, never returned to clients. Onboarded in
// the UI per account, so each org brings its own sender; nothing is read from env.

/** Safe connection metadata exposed to clients (never the API key). */
export interface EmailConnection {
  provider: EmailProviderKind
  fromAddress: string
  connectedAt: number
}

export interface EmailConnectionServiceDependencies {
  emailConnectionRepository: EmailConnectionRepository
  secretCipher: SecretCipher
  clock: Clock
}

function toConnection(record: EmailConnectionRecord): EmailConnection {
  return {
    provider: record.provider,
    fromAddress: record.fromAddress,
    connectedAt: record.createdAt,
  }
}

export class EmailConnectionService {
  constructor(private readonly deps: EmailConnectionServiceDependencies) {}

  /** Connect an account's email sender by storing the provider + sealed API key. */
  async connect(
    accountId: string,
    input: { provider: EmailProviderKind; apiKey: string; fromAddress: string },
  ): Promise<EmailConnection> {
    if (!input.apiKey.trim()) throw new ValidationError('API key is required')
    if (!input.fromAddress.trim()) throw new ValidationError('From address is required')
    // getByAccount already filters tombstones, so a present record is a live one whose
    // original createdAt we preserve; a reconnect after disconnect starts a fresh one.
    const existing = await this.deps.emailConnectionRepository.getByAccount(accountId)
    const apiKeyCipher = await this.deps.secretCipher.encrypt(input.apiKey.trim())
    const now = this.deps.clock.now()
    const record: EmailConnectionRecord = {
      accountId,
      provider: input.provider,
      fromAddress: input.fromAddress.trim(),
      apiKeyCipher,
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
      deletedAt: null,
    }
    await this.deps.emailConnectionRepository.upsert(record)
    return toConnection(record)
  }

  /** The account's current connection (safe metadata), or null. */
  async getConnection(accountId: string): Promise<EmailConnection | null> {
    const record = await this.deps.emailConnectionRepository.getByAccount(accountId)
    if (!record || record.deletedAt) return null
    return toConnection(record)
  }

  /** Disconnect the account's email sender (tombstones the binding). */
  async disconnect(accountId: string): Promise<void> {
    const record = await this.deps.emailConnectionRepository.getByAccount(accountId)
    if (!record || record.deletedAt) return
    await this.deps.emailConnectionRepository.softDelete(accountId, this.deps.clock.now())
  }

  /**
   * Build a ready-to-send EmailSender for an account by decrypting its API key, or
   * null when the account has no connection. The resolver the invitation flow uses.
   */
  async resolveSender(accountId: string): Promise<EmailSender | null> {
    const record = await this.deps.emailConnectionRepository.getByAccount(accountId)
    if (!record || record.deletedAt) return null
    const apiKey = await this.deps.secretCipher.decrypt(record.apiKeyCipher)
    return createEmailSender({
      provider: record.provider,
      from: record.fromAddress,
      sendgrid: record.provider === 'sendgrid' ? { apiKey } : undefined,
      resend: record.provider === 'resend' ? { apiKey } : undefined,
    })
  }

  /** Send a test email through the account's configured sender (UI "send test"). */
  async sendTest(accountId: string, to: string): Promise<void> {
    const sender = await this.resolveSender(accountId)
    if (!sender) throw new ValidationError('No email sender is connected for this account')
    const message: EmailMessage = {
      to,
      subject: 'Cat Factory email test',
      text: 'Your Cat Factory email sender is configured correctly.',
      html: '<p>Your Cat Factory email sender is configured correctly.</p>',
    }
    await sender.send(message)
  }
}
