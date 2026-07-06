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
  /**
   * The account-tier monthly spend budget (base pricing currency). Absent/null ⇒ no
   * account-level limit; the effective account budget then falls back to the operator
   * env cap if set, else unlimited. See the tiered-budgets initiative.
   */
  spendMonthlyLimit?: number | null
}

/** Mutable account settings a member-owner can change (see {@link AccountRepository.updateSettings}). */
export interface AccountSettingsPatch {
  /** `null` clears the override (back to the built-in default); `undefined` leaves it. */
  defaultCloudProvider?: CloudProvider | null
  /** Account-tier monthly budget; `null` clears the limit, `undefined` leaves it. */
  spendMonthlyLimit?: number | null
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
  /**
   * Accounts by id, in a single query — the batched form of {@link AccountRepository.get} used to
   * resolve every account a user belongs to without one round-trip per membership. Empty input →
   * empty.
   */
  listByIds(ids: string[]): Promise<AccountRecord[]>
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
