import { ConflictError, NotFoundError, ValidationError, assertFound } from '@cat-factory/kernel'
import type { AccountInvitation, AccountRole } from '@cat-factory/contracts'
import type {
  AccountInvitationRecord,
  AccountInvitationRepository,
  AccountRepository,
  Clock,
  EmailSender,
  IdGenerator,
  Membership,
  MembershipRepository,
} from '@cat-factory/kernel'

// ---------------------------------------------------------------------------
// InvitationService: invite teammates into an org account by email. An owner mints
// an invitation; the invitee redeems an opaque token (delivered by email) to gain
// membership. Only the token's SHA-256 hash is stored — the raw token lives only in
// the emailed accept link. Redeeming for a brand-new email is what lets a person
// without a GitHub account join (their user is created by the auth signup path,
// then this grants the org membership).
// ---------------------------------------------------------------------------

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000

export interface InvitationServiceDependencies {
  invitationRepository: AccountInvitationRepository
  accountRepository: AccountRepository
  membershipRepository: MembershipRepository
  idGenerator: IdGenerator
  clock: Clock
  /**
   * Optional: resolve the account's configured (DB-stored, per-account) email sender
   * at send time. Absent or returning null ⇒ the accept link is returned for manual
   * sharing instead of being emailed.
   */
  resolveEmailSender?: (accountId: string) => Promise<EmailSender | null>
  /** Base URL the accept link points at (the SPA origin). */
  appBaseUrl?: string
}

/** SHA-256 hex digest — Web Crypto, runs on both runtimes. */
async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function toWire(record: AccountInvitationRecord): AccountInvitation {
  return {
    id: record.id,
    accountId: record.accountId,
    email: record.email,
    role: record.role,
    status: record.status,
    invitedBy: record.invitedBy,
    expiresAt: record.expiresAt,
    createdAt: record.createdAt,
  }
}

export interface CreatedInvitation {
  invitation: AccountInvitation
  /** The raw accept token + link (only available at creation; never re-derivable). */
  token: string
  acceptUrl: string | null
  /** Whether the invite email was actually sent (vs. needing manual link sharing). */
  emailed: boolean
}

export class InvitationService {
  constructor(private readonly deps: InvitationServiceDependencies) {}

  /** Invite a teammate by email. Owner-only, org accounts only. */
  async invite(
    accountId: string,
    actingUserId: string,
    email: string,
    role: AccountRole = 'member',
  ): Promise<CreatedInvitation> {
    const account = assertFound(
      await this.deps.accountRepository.get(accountId),
      'Account',
      accountId,
    )
    if (account.type === 'personal') {
      throw new ValidationError('Cannot invite members to a personal account')
    }
    const acting = await this.deps.membershipRepository.get(accountId, actingUserId)
    if (!acting) throw new NotFoundError('Account', accountId)
    if (acting.role !== 'owner') {
      throw new ConflictError('Only an account owner can invite members')
    }

    const normalizedEmail = email.toLowerCase().trim()
    // Supersede any still-pending invite to the same address in this account, so only
    // the freshly-minted token stays live (no pile-up of redeemable links per email).
    const pending = await this.deps.invitationRepository.listByAccount(accountId)
    for (const prior of pending) {
      if (prior.status === 'pending' && prior.email === normalizedEmail) {
        await this.deps.invitationRepository.setStatus(prior.id, 'revoked')
      }
    }
    const token = `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, '')
    const record: AccountInvitationRecord = {
      id: this.deps.idGenerator.next('inv'),
      accountId,
      email: normalizedEmail,
      role,
      tokenHash: await sha256Hex(token),
      invitedBy: actingUserId,
      status: 'pending',
      expiresAt: this.deps.clock.now() + INVITE_TTL_MS,
      createdAt: this.deps.clock.now(),
    }
    await this.deps.invitationRepository.create(record)

    const acceptUrl = this.deps.appBaseUrl
      ? `${this.deps.appBaseUrl.replace(/\/$/, '')}/invite?token=${token}`
      : null
    const sender = this.deps.resolveEmailSender
      ? await this.deps.resolveEmailSender(accountId)
      : null
    let emailed = false
    if (sender && acceptUrl) {
      await sender.send({
        to: normalizedEmail,
        subject: `You've been invited to ${account.name} on Cat Factory`,
        text: `You've been invited to join ${account.name}. Accept: ${acceptUrl}`,
        html: invitationEmailHtml(account.name, acceptUrl),
      })
      emailed = true
    }
    return { invitation: toWire(record), token, acceptUrl, emailed }
  }

  list(accountId: string): Promise<AccountInvitation[]> {
    return this.deps.invitationRepository.listByAccount(accountId).then((rows) => rows.map(toWire))
  }

  /** Revoke a pending invitation (owner-only). */
  async revoke(accountId: string, actingUserId: string, invitationId: string): Promise<void> {
    const acting = await this.deps.membershipRepository.get(accountId, actingUserId)
    if (acting?.role !== 'owner') {
      throw new ConflictError('Only an account owner can revoke invitations')
    }
    const invitation = assertFound(
      await this.deps.invitationRepository.get(invitationId),
      'Invitation',
      invitationId,
    )
    if (invitation.accountId !== accountId) throw new NotFoundError('Invitation', invitationId)
    await this.deps.invitationRepository.setStatus(invitationId, 'revoked')
  }

  /**
   * Peek at a pending invitation by token (no side effects) — lets the SPA show the
   * org name on the accept screen and decide whether the user must sign up first.
   */
  async peek(token: string): Promise<AccountInvitationRecord | null> {
    const record = await this.deps.invitationRepository.findByTokenHash(await sha256Hex(token))
    if (!record || record.status !== 'pending') return null
    if (record.expiresAt < this.deps.clock.now()) return null
    return record
  }

  /**
   * Redeem an invitation: grant the user membership in the org and mark it accepted.
   * Returns the account id joined.
   *
   * The redemption is bound to the invited email: the accepting user's verified email
   * must match the address the invite was sent to. This stops a leaked accept link from
   * admitting an arbitrary account (the invite token also short-circuits the sign-in
   * allowlist, so without this binding any leaked link would be a private-deployment
   * bypass). A user with no known email cannot redeem (fail closed).
   */
  async accept(token: string, userId: string, userEmail: string | null): Promise<string> {
    const record = await this.deps.invitationRepository.findByTokenHash(await sha256Hex(token))
    if (!record || record.status !== 'pending') {
      throw new NotFoundError('Invitation', 'token')
    }
    if (record.expiresAt < this.deps.clock.now()) {
      throw new ConflictError('This invitation has expired')
    }
    if (!userEmail || userEmail.toLowerCase().trim() !== record.email) {
      throw new ConflictError('This invitation was sent to a different email address')
    }
    const membership: Membership = {
      accountId: record.accountId,
      userId,
      role: record.role,
      createdAt: this.deps.clock.now(),
    }
    await this.deps.membershipRepository.upsert(membership)
    await this.deps.invitationRepository.setStatus(record.id, 'accepted')
    return record.accountId
  }
}

function invitationEmailHtml(accountName: string, acceptUrl: string): string {
  return `<!doctype html><html><body style="font-family:sans-serif">
<h2>You've been invited to ${escapeHtml(accountName)}</h2>
<p>You've been invited to collaborate on <strong>${escapeHtml(accountName)}</strong> in Cat Factory.</p>
<p><a href="${acceptUrl}" style="display:inline-block;padding:10px 18px;background:#111;color:#fff;border-radius:6px;text-decoration:none">Accept invitation</a></p>
<p>Or paste this link into your browser:<br>${acceptUrl}</p>
</body></html>`
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  )
}
