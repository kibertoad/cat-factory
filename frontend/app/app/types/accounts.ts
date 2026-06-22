// ---------------------------------------------------------------------------
// Account tenancy. An account owns workspaces (boards): either a single user's
// `personal` account or an `org` shared by many engineers. Memberships map users
// to accounts with a role. Mirrors the `@cat-factory/contracts` account schemas
// so responses drop straight into the Pinia store.
// ---------------------------------------------------------------------------

import type { CloudProvider } from './domain'

export type AccountType = 'personal' | 'org'
export type AccountRole = 'owner' | 'member'

/** An account, annotated with the signed-in caller's role in it. */
export interface Account {
  id: string
  type: AccountType
  name: string
  githubAccountLogin: string | null
  createdAt: number
  /** The caller's role in this account (`null` in the auth-disabled path). */
  role: AccountRole | null
  /** The cloud provider new services in this account default to; absent = built-in default. */
  defaultCloudProvider?: CloudProvider
}

/** A member of an account, with display details when resolvable. */
export interface AccountMember {
  accountId: string
  userId: string
  role: AccountRole
  createdAt: number
  name?: string | null
  email?: string | null
  avatarUrl?: string | null
}

export interface CreateAccountInput {
  name: string
  githubAccountLogin?: string
}

/** Update an account's settings (today: its default cloud provider for new services). */
export interface UpdateAccountInput {
  defaultCloudProvider?: CloudProvider
}

export interface AddMemberInput {
  userId: string
  role?: AccountRole
}

/** An email invitation into an org account (never carries the raw token). */
export interface AccountInvitation {
  id: string
  accountId: string
  email: string
  role: AccountRole
  status: 'pending' | 'accepted' | 'revoked'
  invitedBy: string
  expiresAt: number
  createdAt: number
}

export type EmailProviderKind = 'sendgrid' | 'resend'

/** A per-account email-sender connection (safe metadata; never the API key). */
export interface EmailConnection {
  provider: EmailProviderKind
  fromAddress: string
  connectedAt: number
}
