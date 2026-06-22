import type {
  Account,
  AccountMember,
  AccountRole,
  CreateAccountInput,
  UpdateAccountInput,
} from '@cat-factory/kernel'
import type {
  AccountRecord,
  AccountRepository,
  Membership,
  MembershipRepository,
  UserRepository,
} from '@cat-factory/kernel'
import type { Clock, IdGenerator } from '@cat-factory/kernel'
import { ConflictError, NotFoundError, ValidationError, assertFound } from '@cat-factory/kernel'

// ---------------------------------------------------------------------------
// AccountService: the tenancy layer. An account is the owner of workspaces —
// either a single user's `personal` account or an `org` shared by many engineers.
// Memberships map internal users (`usr_*`) to accounts with a role, so visibility
// (which boards you can switch between) is "the accounts you belong to". A GitHub App
// installation is bound to an account, so every workspace in it shares the repos.
// ---------------------------------------------------------------------------

export interface AccountServiceDependencies {
  accountRepository: AccountRepository
  membershipRepository: MembershipRepository
  idGenerator: IdGenerator
  clock: Clock
  /** Optional: resolve member display details (name/email/avatar) for the roster. */
  userRepository?: UserRepository
}

/** The signed-in identity the tenancy decisions are made against. */
export interface AccountUser {
  /** Internal user id (`usr_*`). */
  id: string
  /** GitHub login, when the user signed in via GitHub (else any display handle). */
  login: string
  name: string | null
}

function toWire(account: AccountRecord, roles: Account['roles']): Account {
  return {
    id: account.id,
    type: account.type,
    name: account.name,
    githubAccountLogin: account.githubAccountLogin,
    createdAt: account.createdAt,
    roles,
    ...(account.defaultCloudProvider ? { defaultCloudProvider: account.defaultCloudProvider } : {}),
  }
}

function toMember(m: Membership): AccountMember {
  return { accountId: m.accountId, userId: m.userId, roles: m.roles, createdAt: m.createdAt }
}

export class AccountService {
  constructor(private readonly deps: AccountServiceDependencies) {}

  /**
   * Ensure a user has a personal account (account-of-one) with an owner
   * membership, creating it on first sign-in. Idempotent: keyed by the user's
   * internal id, so repeated calls return the same account.
   */
  async ensurePersonalAccount(user: AccountUser): Promise<AccountRecord> {
    const existing = await this.deps.accountRepository.findPersonalByUser(user.id)
    if (existing) {
      // Self-heal a missing admin membership (e.g. partially-applied prior run).
      await this.ensureMembership(existing.id, user.id, ['admin'])
      return existing
    }
    const account: AccountRecord = {
      id: this.deps.idGenerator.next('acc'),
      type: 'personal',
      name: user.name?.trim() || user.login,
      githubAccountLogin: user.login,
      ownerUserId: user.id,
      createdAt: this.deps.clock.now(),
    }
    await this.deps.accountRepository.create(account)
    await this.ensureMembership(account.id, user.id, ['admin'])
    return account
  }

  /** Create a shared org account; the creator becomes its first owner. */
  async createOrg(user: AccountUser, input: CreateAccountInput): Promise<Account> {
    const account: AccountRecord = {
      id: this.deps.idGenerator.next('acc'),
      type: 'org',
      name: input.name.trim(),
      githubAccountLogin: input.githubAccountLogin?.trim() || null,
      ownerUserId: null,
      createdAt: this.deps.clock.now(),
    }
    await this.deps.accountRepository.create(account)
    await this.ensureMembership(account.id, user.id, ['admin'])
    return toWire(account, ['admin'])
  }

  /**
   * Every account the user can see and switch between (personal first), each
   * annotated with the caller's role. Ensures the personal account exists.
   */
  async listForUser(user: AccountUser): Promise<Account[]> {
    await this.ensurePersonalAccount(user)
    const memberships = await this.deps.membershipRepository.listByUser(user.id)
    const accounts: Account[] = []
    for (const m of memberships) {
      const account = await this.deps.accountRepository.get(m.accountId)
      if (account) accounts.push(toWire(account, m.roles))
    }
    // Personal accounts first, then orgs, each alphabetical — a stable switcher order.
    return accounts.sort(
      (a, b) =>
        (a.type === 'personal' ? 0 : 1) - (b.type === 'personal' ? 0 : 1) ||
        a.name.localeCompare(b.name),
    )
  }

  /** The set of account ids a user belongs to (used to scope board visibility). */
  async accessibleAccountIds(userId: string): Promise<string[]> {
    const memberships = await this.deps.membershipRepository.listByUser(userId)
    return memberships.map((m) => m.accountId)
  }

  async isMember(accountId: string, userId: string): Promise<boolean> {
    return (await this.deps.membershipRepository.get(accountId, userId)) !== null
  }

  /** Resolve the membership or throw 404 — the guard mutating routes use. */
  async requireMember(accountId: string, userId: string): Promise<Membership> {
    const membership = await this.deps.membershipRepository.get(accountId, userId)
    if (!membership) throw new NotFoundError('Account', accountId)
    return membership
  }

  /** A user's roles in an account (empty when not a member). */
  async rolesFor(accountId: string, userId: string): Promise<AccountRole[]> {
    const membership = await this.deps.membershipRepository.get(accountId, userId)
    return membership?.roles ?? []
  }

  /** Whether a user holds a role in an account. */
  async hasRole(accountId: string, userId: string, role: AccountRole): Promise<boolean> {
    return (await this.rolesFor(accountId, userId)).includes(role)
  }

  /**
   * Resolve the membership and require the `admin` role — the guard every
   * org-account-modifying route uses (settings, members, invitations, account-scoped
   * credentials). Throws 404 for a non-member, 409 for a member without `admin`.
   */
  async requireAdmin(accountId: string, userId: string): Promise<Membership> {
    const membership = await this.requireMember(accountId, userId)
    if (!membership.roles.includes('admin')) {
      throw new ConflictError('Only an account admin can modify the organization account')
    }
    return membership
  }

  get(accountId: string): Promise<AccountRecord | null> {
    return this.deps.accountRepository.get(accountId)
  }

  async members(accountId: string): Promise<AccountMember[]> {
    const list = await this.deps.membershipRepository.listByAccount(accountId)
    const users = this.deps.userRepository
    if (!users) return list.map(toMember)
    // Enrich the roster with each member's display details for the UI — one bulk load
    // rather than a query per member.
    const records = await users.listByIds(list.map((m) => m.userId))
    const byId = new Map(records.map((u) => [u.id, u]))
    return list.map((m) => {
      const user = byId.get(m.userId)
      return {
        ...toMember(m),
        name: user?.name ?? null,
        email: user?.email ?? null,
        avatarUrl: user?.avatarUrl ?? null,
      }
    })
  }

  /**
   * Update an account's settings (today: the default cloud provider new services
   * inherit). Owner-only. Returns the updated wire account so the caller can patch
   * its switcher in place.
   */
  async updateSettings(
    accountId: string,
    actingUserId: string,
    input: UpdateAccountInput,
  ): Promise<Account> {
    const acting = await this.requireAdmin(accountId, actingUserId)
    // An explicit key (even `undefined`) means "clear"; an absent key leaves it.
    if ('defaultCloudProvider' in input) {
      await this.deps.accountRepository.updateSettings(accountId, {
        defaultCloudProvider: input.defaultCloudProvider ?? null,
      })
    }
    const account = assertFound(
      await this.deps.accountRepository.get(accountId),
      'Account',
      accountId,
    )
    return toWire(account, acting.roles)
  }

  /**
   * Add a member to an account. Only an admin may add, and only into an `org` account
   * (a personal account stays an account-of-one). Defaults to the `developer` role.
   */
  async addMember(
    accountId: string,
    actingUserId: string,
    userId: string,
    roles: AccountRole[] = ['developer'],
  ): Promise<AccountMember> {
    // Authorize first so a non-admin/non-member can't probe an account's existence or
    // type (404 before any ValidationError leak).
    await this.requireAdmin(accountId, actingUserId)
    const account = assertFound(
      await this.deps.accountRepository.get(accountId),
      'Account',
      accountId,
    )
    if (account.type === 'personal') {
      throw new ValidationError('Cannot add members to a personal account')
    }
    const membership: Membership = {
      accountId,
      userId,
      roles: normalizeRoles(roles),
      createdAt: this.deps.clock.now(),
    }
    await this.deps.membershipRepository.upsert(membership)
    return toMember(membership)
  }

  /** Set a member's role set (admin-only). The acting admin cannot drop their OWN admin. */
  async setMemberRoles(
    accountId: string,
    actingUserId: string,
    targetUserId: string,
    roles: AccountRole[],
  ): Promise<AccountMember> {
    await this.requireAdmin(accountId, actingUserId)
    const target = await this.requireMember(accountId, targetUserId)
    const next = normalizeRoles(roles)
    if (actingUserId === targetUserId && !next.includes('admin')) {
      throw new ConflictError('You cannot remove your own admin role')
    }
    const membership: Membership = { ...target, roles: next }
    await this.deps.membershipRepository.upsert(membership)
    return toMember(membership)
  }

  private async ensureMembership(
    accountId: string,
    userId: string,
    roles: AccountRole[],
  ): Promise<void> {
    if (await this.deps.membershipRepository.get(accountId, userId)) return
    await this.deps.membershipRepository.upsert({
      accountId,
      userId,
      roles: normalizeRoles(roles),
      createdAt: this.deps.clock.now(),
    })
  }
}

/** De-duplicate a role set, preserving order, defaulting to `developer` when empty. */
function normalizeRoles(roles: AccountRole[]): AccountRole[] {
  const seen = new Set<AccountRole>()
  for (const r of roles) seen.add(r)
  return seen.size > 0 ? [...seen] : ['developer']
}
