import type { AccountRole, AccountType, CloudProvider } from '../domain/types.js'

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
  /** The user who owns a `personal` account (its account-of-one). Null for orgs. */
  ownerUserId: string | null
  createdAt: number
  /**
   * The cloud provider new services in this account default to (a service may
   * override it per-frame). Absent ⇒ the built-in {@link DEFAULT_CLOUD_PROVIDER}.
   */
  defaultCloudProvider?: CloudProvider
}

/** Mutable account settings a member-owner can change (see {@link AccountRepository.updateSettings}). */
export interface AccountSettingsPatch {
  /** `null` clears the override (back to the built-in default); `undefined` leaves it. */
  defaultCloudProvider?: CloudProvider | null
}

export interface Membership {
  accountId: string
  userId: string
  /** The member's combinable roles (admin / developer / product); at least one. */
  roles: AccountRole[]
  createdAt: number
}

export interface AccountRepository {
  get(id: string): Promise<AccountRecord | null>
  create(account: AccountRecord): Promise<void>
  rename(id: string, name: string): Promise<void>
  /** Apply a settings patch (today: the default cloud provider). A no-op for an empty patch. */
  updateSettings(id: string, patch: AccountSettingsPatch): Promise<void>
  /** The existing personal account owned by a user, if one was already created. */
  findPersonalByUser(userId: string): Promise<AccountRecord | null>
}

export interface MembershipRepository {
  /** Every membership for a user — the accounts they can see and switch between. */
  listByUser(userId: string): Promise<Membership[]>
  /** Every membership in an account — its member roster. */
  listByAccount(accountId: string): Promise<Membership[]>
  get(accountId: string, userId: string): Promise<Membership | null>
  upsert(membership: Membership): Promise<void>
  remove(accountId: string, userId: string): Promise<void>
}
