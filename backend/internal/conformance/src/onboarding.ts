import type {
  AccountRole,
  IdentityProvider,
  UserIdentityRecord,
  UserRecord,
} from '@cat-factory/kernel'

// The cross-runtime probe for the user-identity + onboarding layer (users,
// user_identities, account_invitations). The conformance suite drives it through the
// facade's REAL services + store, so a repository that maps a column differently or a
// facade that forgot to wire the identity layer fails the same assertion on every
// runtime — exactly like the rest of the suite, but for behaviour the unauthenticated
// HTTP `call` path can't reach.

/** The identity-service surface the suite exercises (a subset of `UserService`). */
export interface OnboardingUsersProbe {
  signupWithPassword(input: {
    email: string
    password: string
    name?: string | null
  }): Promise<UserRecord>
  verifyPassword(input: { email: string; password: string }): Promise<UserRecord | null>
  findOrCreateByIdentity(
    provider: IdentityProvider,
    subject: string,
    profile?: { name?: string | null; email?: string | null; emailVerified?: boolean },
  ): Promise<UserRecord>
  findByIdentity(provider: IdentityProvider, subject: string): Promise<UserRecord | null>
  get(id: string): Promise<UserRecord | null>
  listIdentities(userId: string): Promise<UserIdentityRecord[]>
}

/** The invitation surface the suite exercises (a subset of `InvitationService`). */
export interface OnboardingInvitesProbe {
  invite(
    accountId: string,
    actingUserId: string,
    email: string,
    roles?: AccountRole[],
  ): Promise<{ token: string; invitation: { id: string; email: string } }>
  peek(token: string): Promise<{ accountId: string; email: string } | null>
  accept(token: string, userId: string, userEmail: string | null): Promise<string>
}

/** One account a user can switch between, as the account switcher lists it. */
export interface OnboardingUserAccount {
  id: string
  type: string
  roles: string[]
}

export interface OnboardingProbe {
  users: OnboardingUsersProbe
  /** Present only when the facade wires the invitation repository. */
  invitations?: OnboardingInvitesProbe
  /** Create an org owned by a fresh user; returns what the invite assertions need. */
  makeOrgOwner(
    name: string,
  ): Promise<{ accountId: string; ownerUserId: string; ownerEmail: string }>
  members(accountId: string): Promise<{ userId: string }[]>
  /**
   * Add `userId` to `accountId` with `roles` (default `developer`), acting as `actingUserId`
   * (an account admin). The RBAC suite uses it to enroll members B/C into the owning org before
   * scoping them at the workspace tier.
   */
  addAccountMember(
    accountId: string,
    actingUserId: string,
    userId: string,
    roles?: AccountRole[],
  ): Promise<{ userId: string }>
  /**
   * Every account a user can see and switch between (the switcher list) — resolves all of
   * their memberships' accounts in one batched read, so the suite can assert that
   * multi-account resolution maps identically across D1 and Postgres.
   */
  accountsForUser(user: {
    id: string
    login: string
    name: string | null
  }): Promise<OnboardingUserAccount[]>
  /**
   * Concurrently resolve the personal account for ONE fresh user `times` over — the
   * first-sign-in race. Every call runs `ensurePersonalAccount` before any has committed a
   * row, so a check-then-`create` implementation would 500 all-but-one on the personal-account
   * unique index. Returns each call's resolved personal-account id; a correct, idempotent
   * store returns the SAME id every time with no rejection, on both runtimes.
   */
  concurrentPersonalAccounts(
    user: { id: string; login: string; name: string | null },
    times: number,
  ): Promise<string[]>
}

/** The (structural) facade container the probe wraps — every facade's Core satisfies it. */
export interface OnboardingContainer {
  userService: OnboardingUsersProbe
  accountService: {
    createOrg(
      user: { id: string; login: string; name: string | null },
      input: { name: string },
    ): Promise<{ id: string }>
    members(accountId: string): Promise<{ userId: string; email?: string | null }[]>
    addMember(
      accountId: string,
      actingUserId: string,
      userId: string,
      roles?: AccountRole[],
    ): Promise<{ userId: string }>
    listForUser(user: {
      id: string
      login: string
      name: string | null
    }): Promise<{ id: string; type: string; roles: string[] | null }[]>
  }
  invitations?: OnboardingInvitesProbe
}

/** Wrap a facade's real Core services into the runtime-neutral onboarding probe. */
export function makeOnboardingProbe(c: OnboardingContainer): OnboardingProbe {
  return {
    users: c.userService,
    invitations: c.invitations,
    members: (accountId) => c.accountService.members(accountId),
    addAccountMember: (accountId, actingUserId, userId, roles) =>
      c.accountService.addMember(accountId, actingUserId, userId, roles),
    accountsForUser: (user) =>
      c.accountService
        .listForUser(user)
        .then((accounts) =>
          accounts.map((a) => ({ id: a.id, type: a.type, roles: a.roles ?? [] })),
        ),
    async concurrentPersonalAccounts(user, times) {
      // `listForUser` calls `ensurePersonalAccount`; fire it `times` over at once so every
      // call reads "no account yet" before any INSERT commits — the exact first-load race.
      const runs = await Promise.all(
        Array.from({ length: times }, () => c.accountService.listForUser(user)),
      )
      return runs.map((accounts) => {
        const personal = accounts.find((a) => a.type === 'personal')
        if (!personal) throw new Error('no personal account resolved')
        return personal.id
      })
    },
    async makeOrgOwner(name) {
      const subject = `org-owner-${name}-${Math.random().toString(36).slice(2)}`
      const owner = await c.userService.findOrCreateByIdentity('github', subject, {
        name: `${name} owner`,
        email: `${subject}@example.com`,
        emailVerified: true,
      })
      const org = await c.accountService.createOrg(
        { id: owner.id, login: subject, name: owner.name },
        { name },
      )
      return { accountId: org.id, ownerUserId: owner.id, ownerEmail: owner.email ?? '' }
    },
  }
}
