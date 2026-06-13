import type { Clock, GitHubInstallationRepository } from '@cat-factory/core'
import { base64url, pkcs8PemToDer } from './encoding'

// GitHub App authentication, implemented entirely on Web Crypto (`crypto.subtle`)
// so it runs in a plain Workers isolate without Node `crypto`:
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

  /** A valid installation access token, minting + caching one if needed. */
  async installationToken(installationId: number): Promise<string> {
    const cached = await this.deps.installationRepository.getByInstallationId(installationId)
    if (
      cached?.cachedToken &&
      cached.tokenExpiresAt &&
      cached.tokenExpiresAt - TOKEN_SKEW_MS > this.deps.clock.now()
    ) {
      return cached.cachedToken
    }
    return this.mintInstallationToken(installationId)
  }

  private async mintInstallationToken(installationId: number): Promise<string> {
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
      throw new Error(
        `Failed to mint installation token for ${installationId} (HTTP ${res.status})`,
      )
    }
    const body = (await res.json()) as AccessTokenResponse
    const expiresAt = Date.parse(body.expires_at)
    // Best-effort cache; updates 0 rows harmlessly if the binding isn't persisted yet.
    await this.deps.installationRepository.updateCachedToken(
      installationId,
      body.token,
      Number.isNaN(expiresAt) ? this.deps.clock.now() + 30 * 60 * 1000 : expiresAt,
    )
    return body.token
  }

  private importKey(): Promise<CryptoKey> {
    if (!this.keyPromise) {
      this.keyPromise = crypto.subtle.importKey(
        'pkcs8',
        pkcs8PemToDer(this.deps.privateKeyPem),
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['sign'],
      )
    }
    return this.keyPromise
  }
}
