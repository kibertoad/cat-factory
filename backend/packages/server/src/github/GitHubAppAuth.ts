import type {
  Clock,
  GitHubInstallationRepository,
  InstallationPermissions,
} from '@cat-factory/kernel'
import { GITHUB_SETTINGS_URLS, VCS_DOC_URLS } from '@cat-factory/kernel'
import { base64url, pkcs8PemToDer } from '../crypto/encoding.js'

// GitHub App authentication, implemented entirely on Web Crypto (`crypto.subtle`)
// so it runs in a plain Workers isolate without Node `crypto` — and identically
// under Node, where `crypto.subtle` is a global too:
//   - the *app JWT* (RS256) authenticates as the App itself, used to mint tokens
//     and read installation metadata;
//   - *installation tokens* (short-lived, ~1h) authenticate as a specific
//     installation for repo reads/writes, cached in the installation row.
//
// The signing key is imported once and reused. Tokens are treated as expired a
// few minutes early to avoid using one that lapses mid-request; a cache miss is
// harmless since a fresh token is cheaply minted from the app JWT.

const TOKEN_SKEW_MS = 5 * 60 * 1000
const USER_AGENT = 'cat-factory'
const API_VERSION = '2022-11-28'

/**
 * Turn a failed installation-token mint into an actionable message (error-message coverage C3).
 * The App JWT → `/access_tokens` call is not a `VcsClient` request, so it doesn't route through
 * `describeVcsApiError`; this is the local equivalent for that one endpoint.
 *
 * IMPORTANT: the first line is UNCHANGED — `Failed to mint installation token for <id> (HTTP
 * <status>)` — because the stale-installation reconcile classifies purely by matching this phrase
 * (`isInstallationTokenGoneError` regex `/Failed to mint installation token .*\(HTTP (404|410)\)/`
 * and `isInstallationGoneError` `/\(HTTP (401|404|410)\)/` in `reconcileStaleRepos.ts`). We only
 * APPEND a cause + remedy so elaborating the text never changes classification. Exported for
 * unit testing, mirroring `explainMigrationFailure`.
 */
export function explainInstallationTokenMintFailure(
  installationId: number,
  status: number,
): string {
  const base = `Failed to mint installation token for ${installationId} (HTTP ${status})`
  if (status === 401) {
    return (
      `${base}\nCause: the App failed to authenticate — GITHUB_APP_PRIVATE_KEY does not match this ` +
      `App, or the key was rotated in the App settings. Fix: set GITHUB_APP_PRIVATE_KEY to the ` +
      `App's current private key (PKCS#8 PEM). Manage the App at ${GITHUB_SETTINGS_URLS.installations}. ` +
      `See ${VCS_DOC_URLS.githubOperations}.`
    )
  }
  if (status === 404 || status === 410) {
    return (
      `${base}\nCause: installation ${installationId} no longer exists — the GitHub App was ` +
      `uninstalled from the org/repo, or this workspace points at a stale installation. Fix: ` +
      `reinstall the App and reconnect GitHub for the workspace (Settings → GitHub). Manage ` +
      `installations at ${GITHUB_SETTINGS_URLS.installations}. See ${VCS_DOC_URLS.githubIntegration}.`
    )
  }
  if (status === 403) {
    return (
      `${base}\nCause: the App JWT was rejected or rate-limited for this installation. Fix: verify ` +
      `GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY are current and the server clock is accurate, then ` +
      `retry shortly. See ${VCS_DOC_URLS.githubOperations}.`
    )
  }
  return base
}

/**
 * Installation tokens (live ~1h repo read/write credentials) are cached IN
 * MEMORY, per isolate/process — never persisted. Persisting them put a plaintext
 * credential at rest (readable from any DB dump / console / SQLi elsewhere); an
 * in-memory cache keeps the hit rate high for a warm process while the token never
 * outlives it. A cache miss just re-mints cheaply from the app JWT. The
 * module-level map intentionally persists across requests within the same process.
 */
const tokenCache = new Map<
  number,
  { token: string; expiresAt: number; permissions: InstallationPermissions }
>()

export interface GitHubAppAuthDependencies {
  appId: string
  /** App private key in PKCS#8 PEM (`-----BEGIN PRIVATE KEY-----`). */
  privateKeyPem: string
  installationRepository: GitHubInstallationRepository
  clock: Clock
  apiBase: string
}

interface AccessTokenResponse {
  token: string
  expires_at: string
  /** The permissions actually granted to this token (App ∩ install approval). */
  permissions?: InstallationPermissions
}

export class GitHubAppAuth {
  private keyPromise?: Promise<CryptoKey>

  constructor(private readonly deps: GitHubAppAuthDependencies) {}

  /** A short-lived RS256 JWT authenticating as the App. */
  async appJwt(): Promise<string> {
    const key = await this.importKey()
    const nowSec = Math.floor(this.deps.clock.now() / 1000)
    const header = { alg: 'RS256', typ: 'JWT' }
    // `iat` is backdated 60s to tolerate clock skew; GitHub caps `exp` at 10min.
    const payload = { iat: nowSec - 60, exp: nowSec + 9 * 60, iss: this.deps.appId }
    const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`
    const signature = await crypto.subtle.sign(
      { name: 'RSASSA-PKCS1-v1_5' },
      key,
      new TextEncoder().encode(signingInput),
    )
    return `${signingInput}.${base64url(signature)}`
  }

  /**
   * A valid installation access token, minting + caching one if needed. Pass
   * `forceRefresh` to bypass the in-memory cache and mint a fresh token: a token
   * bakes in its repo set + permission scopes at mint time, so one minted before
   * the user granted the App access keeps reporting the old (no-write) grant for up
   * to ~1h. The fresh mint replaces the cached entry, so subsequent calls (and the
   * bootstrap push token, which reads the same cache) pick up the new grant too.
   */
  async installationToken(
    installationId: number,
    opts?: { forceRefresh?: boolean },
  ): Promise<string> {
    return (await this.cachedToken(installationId, opts?.forceRefresh)).token
  }

  /**
   * The permissions the installation token actually carries (App ∩ what the
   * install approved) — the source of truth for capability checks. Comes free
   * with the mint response and is cached alongside the token, so a warm process
   * answers without a network call. Used by the provisioner to guard privileged
   * actions (e.g. repo creation) before attempting them.
   */
  async installationPermissions(installationId: number): Promise<InstallationPermissions> {
    return (await this.cachedToken(installationId)).permissions
  }

  private async cachedToken(
    installationId: number,
    forceRefresh = false,
  ): Promise<{ token: string; permissions: InstallationPermissions }> {
    if (!forceRefresh) {
      const cached = tokenCache.get(installationId)
      if (cached && cached.expiresAt - TOKEN_SKEW_MS > this.deps.clock.now()) {
        return cached
      }
    }
    return this.mintInstallationToken(installationId)
  }

  private async mintInstallationToken(
    installationId: number,
  ): Promise<{ token: string; permissions: InstallationPermissions }> {
    const jwt = await this.appJwt()
    const res = await fetch(
      `${this.deps.apiBase}/app/installations/${installationId}/access_tokens`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${jwt}`,
          accept: 'application/vnd.github+json',
          'user-agent': USER_AGENT,
          'x-github-api-version': API_VERSION,
        },
      },
    )
    if (!res.ok) {
      throw new Error(explainInstallationTokenMintFailure(installationId, res.status))
    }
    const body = (await res.json()) as AccessTokenResponse
    const expiresAt = Date.parse(body.expires_at)
    const entry = {
      token: body.token,
      permissions: body.permissions ?? {},
      expiresAt: Number.isNaN(expiresAt) ? this.deps.clock.now() + 30 * 60 * 1000 : expiresAt,
    }
    // In-memory only (see tokenCache note) — never persisted.
    tokenCache.set(installationId, entry)
    return entry
  }

  private importKey(): Promise<CryptoKey> {
    if (!this.keyPromise) {
      // The config loaders validate the key's SHAPE at boot (PKCS#8 PEM + decodable body — see
      // `requireGitHubAppPrivateKey`), so the common malformed cases fail on the misconfigured
      // screen. A body that is valid base64 but not actually a PKCS#8 RSA key still slips through
      // to here and would reject opaquely, so name the var + the openssl conversion on failure.
      this.keyPromise = crypto.subtle
        .importKey(
          'pkcs8',
          pkcs8PemToDer(this.deps.privateKeyPem),
          { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
          false,
          ['sign'],
        )
        .catch((cause) => {
          throw new Error(
            'GITHUB_APP_PRIVATE_KEY could not be imported as a PKCS#8 RSA private key. Ensure it is ' +
              "the GitHub App's private key converted to PKCS#8 (`-----BEGIN PRIVATE KEY-----`) with " +
              '`openssl pkcs8 -topk8 -nocrypt -in key.pem -out key.pk8.pem`. ' +
              `See ${VCS_DOC_URLS.githubOperations}.`,
            { cause },
          )
        })
    }
    return this.keyPromise
  }
}
