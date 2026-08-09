import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { VcsProvider } from '@cat-factory/kernel'
import { MIN_ENCRYPTION_KEY_BYTES } from '@cat-factory/server'
import { openSqliteDb, queryOne } from './db.js'

// The deployment's OWN source-control credential, on the machine that runs it.
//
// Local mode has no GitHub-App connect flow: ONE PAT is both the sign-in identity and the
// operational credential every agent step clones, pushes, gates and merges with. `.env` is the
// operator's way to set it; this store is the developer's, so a token created from the sign-in
// screen takes effect without editing a file or restarting the server. It holds exactly one row
// (one machine, one deployment credential) and is used in BOTH local topologies — the
// Postgres-backed one and mothership mode, which has no Postgres at all.
//
// Why a synchronous sealer rather than the shared `WebCryptoSecretCipher`: the credential is read
// on the way into a container dispatch, a gate probe, a clone URL and a repo enumeration, and
// those call sites want a plain synchronous answer. A promise there would either force every
// reader to become async or leave a window at boot where the deployment reports "no credential"
// while the decryption it already has on disk is still in flight — the boot state reading as the
// permanent one is exactly the failure this whole seam exists to remove. `node:sqlite`'s
// `DatabaseSync` is synchronous for the same reason, so the two match.
//
// AES-256-GCM under a key HKDF-derived from the deployment `ENCRYPTION_KEY` (the same master key
// and the same per-domain-`info` separation `WebCryptoSecretCipher` applies, so this store's
// envelopes are cryptographically unrelated to the API-key or subscription pools').

/** The fixed key for the deployment-credential singleton row (one machine, one credential). */
const CREDENTIAL_ID = 'deployment'

/** Domain separation for the derived key — the sibling of the other stores' cipher `info`. */
const HKDF_INFO = 'cat-factory:local-vcs-credential'

/** Envelope version, so a future format change is a recognisable value rather than a decrypt failure. */
const ENVELOPE_VERSION = 'v1'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS vcs_credential (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  token_cipher TEXT NOT NULL,
  login TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`

interface CredentialRow {
  provider: string
  token_cipher: string
  login: string | null
  created_at: number
  updated_at: number
}

/** The stored deployment credential, decrypted. */
export interface StoredVcsCredential {
  provider: VcsProvider
  token: string
  /** The account handle the token resolved to when it was installed, for display. */
  login: string | null
  updatedAt: number
}

/** The deployment-credential store plus a handle to close the underlying db. */
export interface LocalVcsCredentialStore {
  /** The stored credential, or null when none was ever installed. */
  read(): StoredVcsCredential | null
  /** Replace the stored credential (there is only ever one). */
  write(input: { provider: VcsProvider; token: string; login: string | null }): void
  /** Forget the stored credential. */
  clear(): void
  close(): void
}

/**
 * Derive this store's 32-byte AES key from the deployment master key. `ENCRYPTION_KEY` is base64
 * (the format every other store reads it in), and too-weak input is a configuration error the
 * caller surfaces rather than something to paper over with a weaker key.
 *
 * The DECODED LENGTH is the actual check, not the base64 parse: `Buffer.from(x, 'base64')` is
 * lenient — it skips what it cannot decode rather than throwing — so a garbage value yields a
 * short buffer, not an empty one, and testing only for empty would silently seal the deployment's
 * token under a handful of bytes. The floor is the one every facade's config loader already
 * enforces (`requireEncryptionKey`), shared rather than re-picked so this store can never end up
 * accepting a key the boot path rejects, or the reverse.
 */
function deriveKey(masterKeyBase64: string): Buffer {
  const master = Buffer.from(masterKeyBase64, 'base64')
  if (master.length < MIN_ENCRYPTION_KEY_BYTES) {
    throw new Error(
      `ENCRYPTION_KEY decodes to only ${master.length} byte(s); it must decode to at least ${MIN_ENCRYPTION_KEY_BYTES}, so the local credential cannot be sealed`,
    )
  }
  return Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), HKDF_INFO, 32))
}

/** Seal a token into a `v1:<iv>:<tag>:<ciphertext>` envelope (all parts base64). */
function seal(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return [
    ENVELOPE_VERSION,
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    body.toString('base64'),
  ].join(':')
}

/**
 * Open a sealed envelope, or return null when it cannot be read — a rotated `ENCRYPTION_KEY`, a
 * truncated file, or a future envelope version. Null is the honest answer for all three: the
 * deployment has no USABLE credential, which is the state the sign-in screen already knows how to
 * fix. It is deliberately not an exception, which would take the whole boot down over a value the
 * user can simply re-enter.
 */
function open(key: Buffer, envelope: string): string | null {
  const [version, iv, tag, body] = envelope.split(':')
  if (version !== ENVELOPE_VERSION || !iv || !tag || !body) return null
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'))
    decipher.setAuthTag(Buffer.from(tag, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString(
      'utf8',
    )
  } catch {
    // silent-catch-ok: an unreadable envelope IS the "no usable credential" answer this returns,
    // and the caller reports that state to the user; re-raising would only turn a re-enterable
    // credential into a failed boot.
    return null
  }
}

class SqliteVcsCredentialStore implements LocalVcsCredentialStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly key: Buffer,
    private readonly now: () => number,
  ) {}

  read(): StoredVcsCredential | null {
    const row = queryOne<CredentialRow>(
      this.db,
      'SELECT provider, token_cipher, login, created_at, updated_at FROM vcs_credential WHERE id = ?',
      CREDENTIAL_ID,
    )
    if (!row) return null
    const token = open(this.key, row.token_cipher)
    if (!token) return null
    return {
      provider: row.provider as VcsProvider,
      token,
      login: row.login,
      updatedAt: row.updated_at,
    }
  }

  write(input: { provider: VcsProvider; token: string; login: string | null }): void {
    const now = this.now()
    this.db
      .prepare(
        `INSERT INTO vcs_credential (id, provider, token_cipher, login, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           provider = excluded.provider,
           token_cipher = excluded.token_cipher,
           login = excluded.login,
           updated_at = excluded.updated_at`,
      )
      .run(CREDENTIAL_ID, input.provider, seal(this.key, input.token), input.login, now, now)
  }

  clear(): void {
    this.db.prepare('DELETE FROM vcs_credential WHERE id = ?').run(CREDENTIAL_ID)
  }

  close(): void {
    this.db.close()
  }
}

/**
 * Open the deployment-credential store at `path` (a file under the developer's config dir, or
 * `:memory:` in tests), sealing with `masterKeyBase64` (the deployment `ENCRYPTION_KEY`).
 */
export function createLocalVcsCredentialStore(
  path: string,
  masterKeyBase64: string,
  now: () => number = Date.now,
): LocalVcsCredentialStore {
  return new SqliteVcsCredentialStore(openSqliteDb(path, SCHEMA), deriveKey(masterKeyBase64), now)
}
