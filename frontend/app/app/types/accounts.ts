// ---------------------------------------------------------------------------
// Account tenancy. An account owns workspaces (boards): either a single user's
// `personal` account or an `org` shared by many engineers. Memberships map users
// to accounts with a role. Mirrors the `@cat-factory/contracts` account schemas
// so responses drop straight into the Pinia store.
// ---------------------------------------------------------------------------

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
}

/** A member of an account. */
export interface AccountMember {
  accountId: string
  userId: number
  role: AccountRole
  createdAt: number
}

export interface CreateAccountInput {
  name: string
  githubAccountLogin?: string
}

export interface AddMemberInput {
  userId: number
  role?: AccountRole
}
