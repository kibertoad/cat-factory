import type {
  Clock,
  IdGenerator,
  PublicApiKeyRecord,
  PublicApiKeyRepository,
} from '@cat-factory/kernel'
import { ConflictError } from '@cat-factory/kernel'
import { PUBLIC_API_SCOPES, type PublicApiScope } from '@cat-factory/contracts'

// PublicApiKeyService: owns the INBOUND public-API keys external systems present to the
// `/api/v1` surface. Unlike the outbound provider keys (`ApiKeyService`, encrypted so the
// platform can replay them to a vendor), a public-API key is only ever VERIFIED, never
// replayed — so its secret is stored as a one-way PEPPERED HASH (`HMAC-SHA256(secret,
// pepper)`, the pepper being the deployment ENCRYPTION_KEY). The raw key is returned once,
// on issue, and is irrecoverable thereafter. A DB leak yields only hashes, not usable keys.
//
// The raw key is `cf_live_<keyId>.<secret>`: `keyId` (a non-secret `pak_*`) is the lookup
// index, so authentication is an O(1) `getById` + constant-time hash compare — never a scan.

/** Prefix that marks a raw public-API key. */
const RAW_KEY_PREFIX = 'cf_live_'
/** Random bytes in the secret portion (256 bits). */
const SECRET_BYTES = 32
/** Upper bound on live keys per workspace, to bound accidental/abusive growth. */
const MAX_KEYS_PER_WORKSPACE = 50
/**
 * Coarsen the `lastUsedAt` stamp: only re-write it when the prior stamp is older than this. A
 * polling client (e.g. `GET /jobs/:id` every second, or reconnecting SSE streams) would otherwise
 * drive one UPDATE per authenticated request; a minute's granularity is plenty for "last used" and
 * collapses that write amplification.
 */
const LAST_USED_STAMP_THROTTLE_MS = 60_000

export interface PublicApiKeyServiceDependencies {
  repository: PublicApiKeyRepository
  /**
   * The HMAC pepper — the deployment's ENCRYPTION_KEY string. The key's secret is stored
   * as `HMAC-SHA256(secret, pepper)`; the pepper never leaves the backend, so a leaked DB
   * (hashes only) is not enough to forge a key.
   */
  pepper: string
  idGenerator: IdGenerator
  clock: Clock
}

/** The resolved identity of an authenticated public-API call. */
export interface PublicApiKeyAuth {
  keyId: string
  accountId: string
  workspaceId: string
  /** What this key may do (read ⊂ write ⊂ admin) — the public surface gates each route on it. */
  scope: PublicApiScope
}

/** The scope ladder as a rank, so a `have ≥ need` check is one comparison. */
const SCOPE_RANK: Record<PublicApiScope, number> = { read: 0, write: 1, admin: 2 }

/**
 * Whether a key that HOLDS `have` satisfies an endpoint that NEEDS `need`. The ladder is
 * inclusive — an `admin` key satisfies a `write` or `read` requirement — so this is a simple
 * rank comparison, the single source of truth for every `/api/v1` scope gate.
 */
export function scopeSatisfies(have: PublicApiScope, need: PublicApiScope): boolean {
  return SCOPE_RANK[have] >= SCOPE_RANK[need]
}

/** The result of issuing a key: the stored record + the one-time raw secret to hand back. */
export interface IssuedPublicApiKey {
  record: PublicApiKeyRecord
  /** `cf_live_<keyId>.<secret>` — shown once; not recoverable. */
  secret: string
}

export class PublicApiKeyService {
  private hmacKeyPromise?: Promise<CryptoKey>

  constructor(private readonly deps: PublicApiKeyServiceDependencies) {}

  /**
   * Mint a new key for a workspace, returning the record + the one-time raw secret. `scope`
   * (default `write`) is the permission the key carries on `/api/v1` (read ⊂ write ⊂ admin).
   */
  async issue(
    owner: { accountId: string; workspaceId: string; createdByUserId?: string | null },
    label: string,
    scope: PublicApiScope = 'write',
  ): Promise<IssuedPublicApiKey> {
    const live = await this.deps.repository.listByWorkspace(owner.workspaceId)
    if (live.length >= MAX_KEYS_PER_WORKSPACE) {
      throw new ConflictError(
        `This workspace already has the maximum of ${MAX_KEYS_PER_WORKSPACE} public-API keys; ` +
          'revoke one before creating another',
      )
    }
    // Defensive: reject a scope outside the known ladder rather than persisting a row the
    // gate can't rank (the contract already validates the wire input, but `issue` is a public
    // service method other callers could reach).
    if (!PUBLIC_API_SCOPES.includes(scope)) {
      throw new ConflictError(`Unknown public-API key scope: ${scope}`)
    }
    const id = this.deps.idGenerator.next('pak')
    const secret = randomHex(SECRET_BYTES)
    const record: PublicApiKeyRecord = {
      id,
      accountId: owner.accountId,
      workspaceId: owner.workspaceId,
      label,
      scope,
      secretHash: await this.hash(secret),
      createdByUserId: owner.createdByUserId ?? null,
      createdAt: this.deps.clock.now(),
      lastUsedAt: null,
      revokedAt: null,
    }
    await this.deps.repository.add(record)
    return { record, secret: `${RAW_KEY_PREFIX}${id}.${secret}` }
  }

  /** All live keys for a workspace (metadata only, never a secret). */
  async list(workspaceId: string): Promise<PublicApiKeyRecord[]> {
    return this.deps.repository.listByWorkspace(workspaceId)
  }

  /** Revoke a key, scoped to its workspace. Idempotent. */
  async revoke(workspaceId: string, id: string): Promise<void> {
    await this.deps.repository.revoke(workspaceId, id, this.deps.clock.now())
  }

  /**
   * Verify a presented raw key. Returns the resolved scope on success (and stamps
   * `lastUsedAt`), or `null` on any failure — malformed key, unknown id, revoked key, or a
   * secret mismatch. Fail-closed: never throws, never distinguishes the failure reason to the
   * caller (so a probe can't tell "unknown key" from "wrong secret").
   */
  async authenticate(rawKey: string | undefined): Promise<PublicApiKeyAuth | null> {
    const parsed = parseRawKey(rawKey)
    if (!parsed) return null
    const record = await this.deps.repository.getById(parsed.keyId)
    if (!record || record.revokedAt !== null) return null
    const presented = await this.hash(parsed.secret)
    if (!timingSafeEqualHex(presented, record.secretHash)) return null
    // Stamp `lastUsedAt`, but throttled: skip the write when the existing stamp is recent enough,
    // so a frequently-polling caller doesn't drive one UPDATE per request (see the throttle const).
    const now = this.deps.clock.now()
    if (record.lastUsedAt === null || now - record.lastUsedAt >= LAST_USED_STAMP_THROTTLE_MS) {
      await this.deps.repository.markUsed(record.id, now)
    }
    return {
      keyId: record.id,
      accountId: record.accountId,
      workspaceId: record.workspaceId,
      scope: record.scope,
    }
  }

  /**
   * Whether a key id still exists and has not been revoked. A cheap re-check (one `getById`, no
   * hashing, no `markUsed` write) for long-lived connections that authenticated once at open — the
   * SSE stream re-checks it each poll so a mid-stream revoke cuts the connection instead of
   * letting it run to the timeout cap. Not a substitute for {@link authenticate} (no secret proof).
   */
  async isActive(keyId: string): Promise<boolean> {
    const record = await this.deps.repository.getById(keyId)
    return record !== null && record.revokedAt === null
  }

  private hmacKey(): Promise<CryptoKey> {
    if (!this.hmacKeyPromise) {
      this.hmacKeyPromise = crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(this.deps.pepper),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      )
    }
    return this.hmacKeyPromise
  }

  private async hash(secret: string): Promise<string> {
    const sig = await crypto.subtle.sign(
      'HMAC',
      await this.hmacKey(),
      new TextEncoder().encode(secret),
    )
    return toHex(new Uint8Array(sig))
  }
}

/** Split a raw `cf_live_<keyId>.<secret>` into its parts, or null when malformed. */
function parseRawKey(raw: string | undefined): { keyId: string; secret: string } | null {
  if (!raw || !raw.startsWith(RAW_KEY_PREFIX)) return null
  const rest = raw.slice(RAW_KEY_PREFIX.length)
  const dot = rest.indexOf('.')
  if (dot <= 0) return null
  const keyId = rest.slice(0, dot)
  const secret = rest.slice(dot + 1)
  return keyId && secret ? { keyId, secret } : null
}

function randomHex(bytes: number): string {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)))
}

function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

/** Constant-time comparison of two hex strings (length-independent early-out is safe). */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
