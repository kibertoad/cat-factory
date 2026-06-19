import type { AccountRole, AccountType } from '../domain/types.js'

// ---------------------------------------------------------------------------
// Persistence ports for the account tenancy layer (migration 0017). Accounts own
// workspaces; memberships map GitHub users to accounts with a role. The worker
// implements these against D1; the domain never imports a concrete adapter.
//
// These are the *storage* shapes. The wire `Account` (from @cat-factory/contracts)
// additionally carries the caller's role, which services derive from memberships.
// ---------------------------------------------------------------------------

export interface AccountRecord {
  id: string
  type: AccountType
  name: string
  githubAccountLogin: string | null
  createdAt: number
}

export interface Membership {
  accountId: string
  userId: number
  role: AccountRole
  createdAt: number
}

export interface AccountRepository {
  get(id: string): Promise<AccountRecord | null>
  create(account: AccountRecord): Promise<void>
  rename(id: string, name: string): Promise<void>
  /** The existing personal account for a GitHub login, if one was already created. */
  findPersonalByLogin(login: string): Promise<AccountRecord | null>
}

export interface MembershipRepository {
  /** Every membership for a user — the accounts they can see and switch between. */
  listByUser(userId: number): Promise<Membership[]>
  /** Every membership in an account — its member roster. */
  listByAccount(accountId: string): Promise<Membership[]>
  get(accountId: string, userId: number): Promise<Membership | null>
  upsert(membership: Membership): Promise<void>
  remove(accountId: string, userId: number): Promise<void>
}
