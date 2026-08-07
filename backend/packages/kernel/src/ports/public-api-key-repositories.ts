// Persistence port for INBOUND public-API keys — the credentials external systems
// present to the `/api/v1` surface. This is the mirror image of the direct-provider
// key pool (`provider-api-key-repositories.ts`): those are OUTBOUND vendor keys the
// platform must decrypt and replay to an LLM provider, so they are stored encrypted;
// these are only ever VERIFIED, never replayed, so the secret is stored as a one-way
// peppered hash (`HMAC-SHA256(secret, ENCRYPTION_KEY)`) — irrecoverable, so a DB leak
// yields no usable keys. The raw key is shown exactly once, on issue.
//
// A key is scoped to one account + workspace; every call it authenticates is bound to
// that workspace. It also carries a permission `scope` (read ⊂ write ⊂ admin) the public
// surface gates each endpoint on. Both runtimes implement this (Cloudflare D1 + Node/local
// Postgres) so behaviour is identical everywhere.

import type { PublicApiScope } from '@cat-factory/contracts'

/** One public-API key row. `secretHash` is the peppered HMAC digest, never the raw key. */
export interface PublicApiKeyRecord {
  /** `pak_*` — also the non-secret lookup id embedded in the raw `cf_live_<id>.<secret>`. */
  id: string
  accountId: string
  workspaceId: string
  label: string
  /** What the key may do on `/api/v1` (read ⊂ write ⊂ admin). */
  scope: PublicApiScope
  /** Hex `HMAC-SHA256(secret, ENCRYPTION_KEY)` of the key's secret portion. */
  secretHash: string
  /**
   * The user who minted the key — AUDIT + UI attribution. `null` for keys minted with no
   * signed-in session (dev-open) or predating the column. A key is a workspace-scoped SERVICE
   * credential: it does NOT die when its minter loses workspace access (revocation is an explicit
   * admin action), so this is provenance, never an authorization input.
   */
  createdByUserId: string | null
  /**
   * The KEY that minted this one, for a key provisioned headlessly through `POST /api/v1/keys`;
   * `null` for one a person minted in the app (and for every key predating the column).
   *
   * Unlike {@link PublicApiKeyRecord.createdByUserId} this is also a LIFECYCLE link, not only
   * provenance: revoking a key revokes everything it minted, which is what keeps a leaked
   * provisioning key from outliving its own revocation through the keys it left behind. It is
   * still never an authorization input: what a key may do is its own `scope`, nothing else.
   */
  createdByKeyId: string | null
  /**
   * Who this key acts for on the PROVISIONER's side (an OS user id, a tenant slug), supplied at a
   * headless mint and opaque to the platform: never parsed, never resolved against a user, never
   * an authorization input. `null` for a key minted in the app, one provisioned without it, and
   * every row predating the column.
   *
   * Written once and never updated. A key IS one identity: a value that could move would
   * retro-attribute every run the key already started, and those runs pinned their copy at
   * admission precisely so the answer stays the one that was true then.
   */
  externalIdentity: string | null
  createdAt: number
  /** When the key last authenticated a call (null = never used). */
  lastUsedAt: number | null
  /** Tombstone: when set the key is revoked and never authenticates again. */
  revokedAt: number | null
}

export interface PublicApiKeyRepository {
  /** Insert a freshly issued key. */
  add(record: PublicApiKeyRecord): Promise<void>
  /**
   * Fetch one key by its opaque id — the authentication lookup. Returns the row even
   * when revoked (the service enforces the `revokedAt` check + constant-time hash
   * compare), so a caller can distinguish revoked from unknown. `null` when no such id.
   */
  getById(id: string): Promise<PublicApiKeyRecord | null>
  /**
   * All live (non-revoked) keys for a workspace, newest first — the management list. Revoked keys
   * are intentionally excluded (not merely a UI choice): `PublicApiKeyService.issue` enforces its
   * per-workspace cap off this count, so revoking a key MUST free a slot — including tombstones
   * here would let a workspace that churned keys hit the cap permanently.
   */
  listByWorkspace(workspaceId: string): Promise<PublicApiKeyRecord[]>
  /** Stamp `lastUsedAt` on a key after it authenticates a call. Keyed by id alone. */
  markUsed(id: string, at: number): Promise<void>
  /** Revoke a key (stamp `revokedAt`), scoped to its workspace. */
  revoke(workspaceId: string, id: string, at: number): Promise<void>
  /**
   * Revoke every LIVE key that `minterId` minted (one statement, never a read-then-loop), scoped
   * to the minter's workspace. Idempotent, and a no-op for the ordinary key that minted none.
   *
   * A separate method rather than a flag on {@link PublicApiKeyRepository.revoke} because the two
   * are different statements about the world: revoking a key is an operator's decision about that
   * credential, and cascading is the invariant that a minted key never outlives its minter. A
   * caller that had to remember the second call is a caller that eventually forgets it, so
   * `PublicApiKeyService.revoke` issues both and nothing else may revoke.
   */
  revokeMintedBy(workspaceId: string, minterId: string, at: number): Promise<void>
}
