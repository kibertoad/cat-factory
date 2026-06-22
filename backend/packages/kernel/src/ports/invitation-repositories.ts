import type { AccountRole } from '../domain/types.js'

// Persistence port for account invitations. An owner invites someone by email into
// an org account; the invitee redeems an opaque token (delivered by email) to gain
// membership. Only the token's HASH is stored, never the raw token — the raw value
// lives only in the emailed link. Mirrored on both runtimes (D1 ⇄ Drizzle).

export type InvitationStatus = 'pending' | 'accepted' | 'revoked'

export interface AccountInvitationRecord {
  id: string
  accountId: string
  /** Lowercased invitee email. */
  email: string
  /** The roles the invitee gains on acceptance (at least one). */
  roles: AccountRole[]
  /** SHA-256 hash (hex/base64url) of the opaque token; the raw token is never stored. */
  tokenHash: string
  /** User id of the inviter. */
  invitedBy: string
  status: InvitationStatus
  expiresAt: number
  createdAt: number
}

export interface AccountInvitationRepository {
  create(record: AccountInvitationRecord): Promise<void>
  get(id: string): Promise<AccountInvitationRecord | null>
  /** Resolve a pending invitation by its token hash (the redeem path). */
  findByTokenHash(tokenHash: string): Promise<AccountInvitationRecord | null>
  /** Every invitation for an account (the roster's pending/revoked list). */
  listByAccount(accountId: string): Promise<AccountInvitationRecord[]>
  /** Update an invitation's status (accept / revoke). */
  setStatus(id: string, status: InvitationStatus): Promise<void>
}
