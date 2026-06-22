import type {
  Account,
  AccountMember,
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
// Memberships map GitHub users to accounts with a role, so visibility (which
// boards you can switch between) is "the accounts you belong to". A GitHub App
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

function toWire(account: AccountRecord, role: Account['role']): Account {
  return {
    id: account.id,
    type: account.type,
    name: account.name,
    githubAccountLogin: account.githubAccountLogin,
    createdAt: account.createdAt,
    role,
    ...(account.defaultCloudProvider ? { defaultCloudProvider: account.defaultCloudProvider } : {}),
  }
}

function toMember(m: Membership): AccountMember {
  return { accountId: m.accountId, userId: m.userId, role: m.role, createdAt: m.createdAt }
}

export class AccountService {
  constructor(private readonly deps: AccountServiceDependencies) {}

  /**
   * Ensure a user has a personal account (account-of-one) with an owner
   * membership, creating it on first sign-in. Idempotent: keyed by the user's
   * GitHub login, so repeated calls return the same account.
   */
  async ensurePersonalAccount(user: AccountUser): Promise<AccountRecord> {
    const existing = await this.deps.accountRepository.findPersonalByUser(user.id)
    if (existing) {
      // Self-heal a missing owner membership (e.g. partially-applied prior run).
      await this.ensureMembership(existing.id, user.id, 'owner')
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
    await this.ensureMembership(account.id, user.id, 'owner')
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
    await this.ensureMembership(account.id, user.id, 'owner')
    return toWire(account, 'owner')
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
      if (account) accounts.push(toWire(account, m.role))
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

  get(accountId: string): Promise<AccountRecord | null> {
    return this.deps.accountRepository.get(accountId)
  }

  async members(accountId: string): Promise<AccountMember[]> {
    const list = await this.deps.membershipRepository.listByAccount(accountId)
    const users = this.deps.userRepository
    if (!users) return list.map(toMember)
    // Enrich the roster with each member's display details for the UI.
    return Promise.all(
      list.map(async (m) => {
        const user = await users.get(m.userId)
        return {
          ...toMember(m),
          name: user?.name ?? null,
          email: user?.email ?? null,
          avatarUrl: user?.avatarUrl ?? null,
        }
      }),
    )
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
    const acting = await this.requireMember(accountId, actingUserId)
    if (acting.role !== 'owner') {
      throw new ConflictError('Only an account owner can change account settings')
    }
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
    return toWire(account, acting.role)
  }

  /**
   * Add a member to an account. Only an existing owner may invite, and only into
   * an `org` account (a personal account stays an account-of-one).
   */
  async addMember(
    accountId: string,
    actingUserId: string,
    userId: string,
    role: Membership['role'] = 'member',
  ): Promise<AccountMember> {
    const account = assertFound(
      await this.deps.accountRepository.get(accountId),
      'Account',
      accountId,
    )
    if (account.type === 'personal') {
      throw new ValidationError('Cannot add members to a personal account')
    }
    const acting = await this.requireMember(accountId, actingUserId)
    if (acting.role !== 'owner') {
      throw new ConflictError('Only an account owner can add members')
    }
    const membership: Membership = {
      accountId,
      userId,
      role,
      createdAt: this.deps.clock.now(),
    }
    await this.deps.membershipRepository.upsert(membership)
    return toMember(membership)
  }

  private async ensureMembership(
    accountId: string,
    userId: string,
    role: Membership['role'],
  ): Promise<void> {
    if (await this.deps.membershipRepository.get(accountId, userId)) return
    await this.deps.membershipRepository.upsert({
      accountId,
      userId,
      role,
      createdAt: this.deps.clock.now(),
    })
  }
}
