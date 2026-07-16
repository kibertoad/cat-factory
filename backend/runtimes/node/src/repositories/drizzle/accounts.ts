// Drizzle/Postgres implementations of the core kernel repository ports, split by
// domain (mirrors the Cloudflare D1 per-repository layout). The row<->domain mapping
// is the SAME shared mapping the D1 repos use (@cat-factory/server), so behaviour
// matches across stores; this layer only owns the Drizzle queries. Assembled into the
// CoreRepositories set by ./drizzle.ts (the barrel).

import type {
  AccountInvitationRecord,
  AccountInvitationRepository,
  AccountRecord,
  AccountRepository,
  AccountRole,
  AccountSettingsPatch,
  CloudProvider,
  EmailConnectionRecord,
  EmailConnectionRepository,
  EmailProviderKind,
  IdentityProvider,
  Membership,
  MembershipRepository,
  PasswordResetTokenRecord,
  PasswordResetTokenRepository,
  PasswordResetTokenStatus,
  UserIdentityRecord,
  UserRecord,
  UserRepository,
} from '@cat-factory/kernel'
import { and, desc, eq, inArray, isNull, lt } from 'drizzle-orm'
import type { DrizzleDb } from '../../db/client.js'
import {
  accountInvitations,
  accounts,
  emailConnections,
  memberships,
  passwordResetTokens,
  userIdentities,
  users,
} from '../../db/schema.js'

function rowToAccount(row: typeof accounts.$inferSelect): AccountRecord {
  return {
    id: row.id,
    type: row.type === 'org' ? 'org' : 'personal',
    name: row.name,
    githubAccountLogin: row.github_account_login,
    ownerUserId: row.owner_user_id,
    createdAt: row.created_at,
    ...(row.default_cloud_provider
      ? { defaultCloudProvider: row.default_cloud_provider as CloudProvider }
      : {}),
    ...(row.spend_monthly_limit != null ? { spendMonthlyLimit: row.spend_monthly_limit } : {}),
  }
}

export class DrizzleAccountRepository implements AccountRepository {
  constructor(private readonly db: DrizzleDb) {}

  async get(id: string): Promise<AccountRecord | null> {
    const [row] = await this.db.select().from(accounts).where(eq(accounts.id, id))
    return row ? rowToAccount(row) : null
  }

  async listByIds(ids: string[]): Promise<AccountRecord[]> {
    if (ids.length === 0) return []
    const out: AccountRecord[] = []
    // Chunk the IN list to stay well under the bind-parameter limit.
    for (let i = 0; i < ids.length; i += 500) {
      const rows = await this.db
        .select()
        .from(accounts)
        .where(inArray(accounts.id, ids.slice(i, i + 500)))
      for (const row of rows) out.push(rowToAccount(row))
    }
    return out
  }

  async create(account: AccountRecord): Promise<void> {
    await this.db.insert(accounts).values({
      id: account.id,
      type: account.type,
      name: account.name,
      github_account_login: account.githubAccountLogin,
      owner_user_id: account.ownerUserId,
      created_at: account.createdAt,
      default_cloud_provider: account.defaultCloudProvider ?? null,
      spend_monthly_limit: account.spendMonthlyLimit ?? null,
    })
  }

  async ensurePersonal(account: AccountRecord): Promise<AccountRecord> {
    // Atomic get-or-create: `ON CONFLICT DO NOTHING` no-ops when a personal account already
    // exists for this owner (the partial unique index `idx_accounts_personal` arbitrates), so
    // concurrent first-sign-in callers converge on the one surviving row instead of racing to
    // a duplicate-key error. Re-select to return whichever row won.
    await this.db
      .insert(accounts)
      .values({
        id: account.id,
        type: account.type,
        name: account.name,
        github_account_login: account.githubAccountLogin,
        owner_user_id: account.ownerUserId,
        created_at: account.createdAt,
        default_cloud_provider: account.defaultCloudProvider ?? null,
        spend_monthly_limit: account.spendMonthlyLimit ?? null,
      })
      .onConflictDoNothing()
    const row = await this.findPersonalByUser(account.ownerUserId ?? '')
    if (!row) {
      throw new Error(
        `ensurePersonal: personal account missing after insert for ${account.ownerUserId}`,
      )
    }
    return row
  }

  async rename(id: string, name: string): Promise<void> {
    await this.db.update(accounts).set({ name }).where(eq(accounts.id, id))
  }

  async updateSettings(id: string, patch: AccountSettingsPatch): Promise<void> {
    const set: Partial<typeof accounts.$inferInsert> = {}
    if ('defaultCloudProvider' in patch) {
      set.default_cloud_provider = patch.defaultCloudProvider ?? null
    }
    if ('spendMonthlyLimit' in patch) {
      set.spend_monthly_limit = patch.spendMonthlyLimit ?? null
    }
    if (Object.keys(set).length === 0) return
    await this.db.update(accounts).set(set).where(eq(accounts.id, id))
  }

  async findPersonalByUser(userId: string): Promise<AccountRecord | null> {
    const [row] = await this.db
      .select()
      .from(accounts)
      .where(and(eq(accounts.type, 'personal'), eq(accounts.owner_user_id, userId)))
    return row ? rowToAccount(row) : null
  }
}

/** Parse the CSV `roles` column into a non-empty role set (defaults to developer). */

function parseRoles(csv: string | null): AccountRole[] {
  const roles = (csv ?? '')
    .split(',')
    .map((r) => r.trim())
    .filter((r): r is AccountRole => r === 'admin' || r === 'developer' || r === 'product')
  return roles.length > 0 ? [...new Set(roles)] : ['developer']
}

function rowToMembership(row: typeof memberships.$inferSelect): Membership {
  return {
    accountId: row.account_id,
    userId: row.user_id,
    roles: parseRoles(row.roles),
    createdAt: row.created_at,
  }
}

export class DrizzleMembershipRepository implements MembershipRepository {
  constructor(private readonly db: DrizzleDb) {}

  async listByUser(userId: string): Promise<Membership[]> {
    const rows = await this.db
      .select()
      .from(memberships)
      .where(eq(memberships.user_id, userId))
      .orderBy(memberships.created_at)
    return rows.map(rowToMembership)
  }

  async listByAccount(accountId: string): Promise<Membership[]> {
    const rows = await this.db
      .select()
      .from(memberships)
      .where(eq(memberships.account_id, accountId))
      .orderBy(memberships.created_at)
    return rows.map(rowToMembership)
  }

  async get(accountId: string, userId: string): Promise<Membership | null> {
    const [row] = await this.db
      .select()
      .from(memberships)
      .where(and(eq(memberships.account_id, accountId), eq(memberships.user_id, userId)))
    return row ? rowToMembership(row) : null
  }

  async upsert(membership: Membership): Promise<void> {
    await this.db
      .insert(memberships)
      .values({
        account_id: membership.accountId,
        user_id: membership.userId,
        roles: membership.roles.join(','),
        created_at: membership.createdAt,
      })
      .onConflictDoUpdate({
        target: [memberships.account_id, memberships.user_id],
        set: { roles: membership.roles.join(',') },
      })
  }

  async remove(accountId: string, userId: string): Promise<void> {
    await this.db
      .delete(memberships)
      .where(and(eq(memberships.account_id, accountId), eq(memberships.user_id, userId)))
  }
}

function rowToUser(row: typeof users.$inferSelect): UserRecord {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    avatarUrl: row.avatar_url,
    createdAt: row.created_at,
  }
}

function rowToIdentity(row: typeof userIdentities.$inferSelect): UserIdentityRecord {
  return {
    userId: row.user_id,
    provider: row.provider as IdentityProvider,
    subject: row.subject,
    secret: row.secret,
    metadata: row.metadata,
    createdAt: row.created_at,
  }
}

export class DrizzleUserRepository implements UserRepository {
  constructor(private readonly db: DrizzleDb) {}

  async get(id: string): Promise<UserRecord | null> {
    const [row] = await this.db.select().from(users).where(eq(users.id, id))
    return row ? rowToUser(row) : null
  }

  async create(user: UserRecord): Promise<void> {
    await this.db.insert(users).values({
      id: user.id,
      name: user.name,
      email: user.email,
      avatar_url: user.avatarUrl,
      created_at: user.createdAt,
    })
  }

  async update(
    id: string,
    patch: Partial<Pick<UserRecord, 'name' | 'email' | 'avatarUrl'>>,
  ): Promise<void> {
    const set: Record<string, unknown> = {}
    if ('name' in patch) set.name = patch.name
    if ('email' in patch) set.email = patch.email
    if ('avatarUrl' in patch) set.avatar_url = patch.avatarUrl
    if (Object.keys(set).length === 0) return
    await this.db.update(users).set(set).where(eq(users.id, id))
  }

  async findByIdentity(provider: IdentityProvider, subject: string): Promise<UserRecord | null> {
    const [row] = await this.db
      .select()
      .from(users)
      .innerJoin(userIdentities, eq(userIdentities.user_id, users.id))
      .where(and(eq(userIdentities.provider, provider), eq(userIdentities.subject, subject)))
    return row ? rowToUser(row.users) : null
  }

  async findByEmail(email: string): Promise<UserRecord | null> {
    const [row] = await this.db
      .select()
      .from(users)
      .where(eq(users.email, email.toLowerCase().trim()))
    return row ? rowToUser(row) : null
  }

  async listByIds(ids: string[]): Promise<UserRecord[]> {
    if (ids.length === 0) return []
    const rows = await this.db.select().from(users).where(inArray(users.id, ids))
    return rows.map(rowToUser)
  }

  async getIdentity(
    provider: IdentityProvider,
    subject: string,
  ): Promise<UserIdentityRecord | null> {
    const [row] = await this.db
      .select()
      .from(userIdentities)
      .where(and(eq(userIdentities.provider, provider), eq(userIdentities.subject, subject)))
    return row ? rowToIdentity(row) : null
  }

  async linkIdentity(identity: UserIdentityRecord): Promise<void> {
    await this.db
      .insert(userIdentities)
      .values({
        user_id: identity.userId,
        provider: identity.provider,
        subject: identity.subject,
        secret: identity.secret,
        metadata: identity.metadata,
        created_at: identity.createdAt,
      })
      .onConflictDoUpdate({
        target: [userIdentities.provider, userIdentities.subject],
        set: { user_id: identity.userId, secret: identity.secret, metadata: identity.metadata },
      })
  }

  async listIdentities(userId: string): Promise<UserIdentityRecord[]> {
    const rows = await this.db
      .select()
      .from(userIdentities)
      .where(eq(userIdentities.user_id, userId))
    return rows.map(rowToIdentity)
  }
}

function rowToInvitation(row: typeof accountInvitations.$inferSelect): AccountInvitationRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    email: row.email,
    roles: parseRoles(row.roles),
    tokenHash: row.token_hash,
    invitedBy: row.invited_by,
    status: row.status as AccountInvitationRecord['status'],
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  }
}

export class DrizzleAccountInvitationRepository implements AccountInvitationRepository {
  constructor(private readonly db: DrizzleDb) {}

  async create(record: AccountInvitationRecord): Promise<void> {
    await this.db.insert(accountInvitations).values({
      id: record.id,
      account_id: record.accountId,
      email: record.email,
      roles: record.roles.join(','),
      token_hash: record.tokenHash,
      invited_by: record.invitedBy,
      status: record.status,
      expires_at: record.expiresAt,
      created_at: record.createdAt,
    })
  }

  async get(id: string): Promise<AccountInvitationRecord | null> {
    const [row] = await this.db
      .select()
      .from(accountInvitations)
      .where(eq(accountInvitations.id, id))
    return row ? rowToInvitation(row) : null
  }

  async findByTokenHash(tokenHash: string): Promise<AccountInvitationRecord | null> {
    const [row] = await this.db
      .select()
      .from(accountInvitations)
      .where(eq(accountInvitations.token_hash, tokenHash))
    return row ? rowToInvitation(row) : null
  }

  async listByAccount(accountId: string): Promise<AccountInvitationRecord[]> {
    const rows = await this.db
      .select()
      .from(accountInvitations)
      .where(eq(accountInvitations.account_id, accountId))
      .orderBy(desc(accountInvitations.created_at))
    return rows.map(rowToInvitation)
  }

  async setStatus(id: string, status: AccountInvitationRecord['status']): Promise<void> {
    await this.db.update(accountInvitations).set({ status }).where(eq(accountInvitations.id, id))
  }
}

function rowToPasswordResetToken(
  row: typeof passwordResetTokens.$inferSelect,
): PasswordResetTokenRecord {
  return {
    id: row.id,
    userId: row.user_id,
    tokenHash: row.token_hash,
    status: row.status as PasswordResetTokenStatus,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  }
}

export class DrizzlePasswordResetTokenRepository implements PasswordResetTokenRepository {
  constructor(private readonly db: DrizzleDb) {}

  async create(record: PasswordResetTokenRecord): Promise<void> {
    await this.db.insert(passwordResetTokens).values({
      id: record.id,
      user_id: record.userId,
      token_hash: record.tokenHash,
      status: record.status,
      expires_at: record.expiresAt,
      created_at: record.createdAt,
    })
  }

  async findByTokenHash(tokenHash: string): Promise<PasswordResetTokenRecord | null> {
    const [row] = await this.db
      .select()
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.token_hash, tokenHash))
    return row ? rowToPasswordResetToken(row) : null
  }

  async listPendingByUser(userId: string): Promise<PasswordResetTokenRecord[]> {
    const rows = await this.db
      .select()
      .from(passwordResetTokens)
      .where(
        and(eq(passwordResetTokens.user_id, userId), eq(passwordResetTokens.status, 'pending')),
      )
      .orderBy(desc(passwordResetTokens.created_at))
    return rows.map(rowToPasswordResetToken)
  }

  async setStatus(id: string, status: PasswordResetTokenStatus): Promise<void> {
    await this.db.update(passwordResetTokens).set({ status }).where(eq(passwordResetTokens.id, id))
  }

  async consume(id: string): Promise<boolean> {
    // Conditional on `status='pending'` so concurrent redemptions can't both win.
    const result = await this.db
      .update(passwordResetTokens)
      .set({ status: 'used' })
      .where(and(eq(passwordResetTokens.id, id), eq(passwordResetTokens.status, 'pending')))
    return (result.rowCount ?? 0) > 0
  }

  async deleteExpired(before: number): Promise<number> {
    const result = await this.db
      .delete(passwordResetTokens)
      .where(lt(passwordResetTokens.expires_at, before))
    return result.rowCount ?? 0
  }
}

function rowToEmailConnection(row: typeof emailConnections.$inferSelect): EmailConnectionRecord {
  return {
    accountId: row.account_id,
    provider: row.provider as EmailProviderKind,
    fromAddress: row.from_address,
    apiKeyCipher: row.api_key_cipher,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  }
}

export class DrizzleEmailConnectionRepository implements EmailConnectionRepository {
  constructor(private readonly db: DrizzleDb) {}

  async getByAccount(accountId: string): Promise<EmailConnectionRecord | null> {
    const [row] = await this.db
      .select()
      .from(emailConnections)
      .where(and(eq(emailConnections.account_id, accountId), isNull(emailConnections.deleted_at)))
    return row ? rowToEmailConnection(row) : null
  }

  async upsert(record: EmailConnectionRecord): Promise<void> {
    await this.db
      .insert(emailConnections)
      .values({
        account_id: record.accountId,
        provider: record.provider,
        from_address: record.fromAddress,
        api_key_cipher: record.apiKeyCipher,
        created_at: record.createdAt,
        updated_at: record.updatedAt,
        deleted_at: record.deletedAt,
      })
      .onConflictDoUpdate({
        target: emailConnections.account_id,
        set: {
          provider: record.provider,
          from_address: record.fromAddress,
          api_key_cipher: record.apiKeyCipher,
          updated_at: record.updatedAt,
          deleted_at: record.deletedAt,
        },
      })
  }

  async softDelete(accountId: string, at: number): Promise<void> {
    await this.db
      .update(emailConnections)
      .set({ deleted_at: at, updated_at: at })
      .where(eq(emailConnections.account_id, accountId))
  }
}
