import type {
  IdentityProvider,
  UserIdentityRecord,
  UserRecord,
  UserRepository,
} from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'

interface UserRow {
  id: string
  name: string | null
  email: string | null
  avatar_url: string | null
  created_at: number
}

interface IdentityRow {
  user_id: string
  provider: string
  subject: string
  secret: string | null
  metadata: string | null
  created_at: number
}

function rowToUser(row: UserRow): UserRecord {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    avatarUrl: row.avatar_url,
    createdAt: row.created_at,
  }
}

function rowToIdentity(row: IdentityRow): UserIdentityRecord {
  return {
    userId: row.user_id,
    provider: row.provider as IdentityProvider,
    subject: row.subject,
    secret: row.secret,
    metadata: row.metadata,
    createdAt: row.created_at,
  }
}

/** D1-backed store of canonical users + their linked login identities. */
export class D1UserRepository implements UserRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async get(id: string): Promise<UserRecord | null> {
    const row = await this.db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<UserRow>()
    return row ? rowToUser(row) : null
  }

  async create(user: UserRecord): Promise<void> {
    await this.db
      .prepare('INSERT INTO users (id, name, email, avatar_url, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(user.id, user.name, user.email, user.avatarUrl, user.createdAt)
      .run()
  }

  async update(
    id: string,
    patch: Partial<Pick<UserRecord, 'name' | 'email' | 'avatarUrl'>>,
  ): Promise<void> {
    const sets: string[] = []
    const binds: (string | null)[] = []
    if ('name' in patch) {
      sets.push('name = ?')
      binds.push(patch.name ?? null)
    }
    if ('email' in patch) {
      sets.push('email = ?')
      binds.push(patch.email ?? null)
    }
    if ('avatarUrl' in patch) {
      sets.push('avatar_url = ?')
      binds.push(patch.avatarUrl ?? null)
    }
    if (sets.length === 0) return
    await this.db
      .prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`)
      .bind(...binds, id)
      .run()
  }

  async findByIdentity(provider: IdentityProvider, subject: string): Promise<UserRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT u.* FROM users u
           JOIN user_identities i ON i.user_id = u.id
          WHERE i.provider = ? AND i.subject = ?`,
      )
      .bind(provider, subject)
      .first<UserRow>()
    return row ? rowToUser(row) : null
  }

  async getIdentity(
    provider: IdentityProvider,
    subject: string,
  ): Promise<UserIdentityRecord | null> {
    const row = await this.db
      .prepare('SELECT * FROM user_identities WHERE provider = ? AND subject = ?')
      .bind(provider, subject)
      .first<IdentityRow>()
    return row ? rowToIdentity(row) : null
  }

  async linkIdentity(identity: UserIdentityRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO user_identities (user_id, provider, subject, secret, metadata, created_at)
           VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (provider, subject) DO UPDATE SET
           user_id = excluded.user_id, secret = excluded.secret, metadata = excluded.metadata`,
      )
      .bind(
        identity.userId,
        identity.provider,
        identity.subject,
        identity.secret,
        identity.metadata,
        identity.createdAt,
      )
      .run()
  }

  async listIdentities(userId: string): Promise<UserIdentityRecord[]> {
    const { results } = await this.db
      .prepare('SELECT * FROM user_identities WHERE user_id = ?')
      .bind(userId)
      .all<IdentityRow>()
    return results.map(rowToIdentity)
  }
}
