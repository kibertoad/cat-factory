import type { InstallationPermissions } from '@cat-factory/kernel'
import type { AppTokenSource } from './GitHubAppRegistry.js'

// The client side of mothership-mode GitHub token delegation. A mothership-mode local
// node has no GitHub App key (product decision: the App private key never reaches the
// laptop) and, without a PAT, no GitHub credential at all — yet its agent containers,
// gates, and RepoFiles ops must reach GitHub. This {@link AppTokenSource} closes that
// gap by minting each installation token FROM THE MOTHERSHIP over the machine API
// (`POST /internal/github/installation-token`, served by `githubDelegationController`),
// so the shared `FetchGitHubClient` — and the executor's push-token mint — run on the
// laptop unchanged, on the same short-lived installation tokens the mothership's own
// engine uses.

/**
 * How long a delegated installation token is served from the in-process memo before the
 * mothership is asked again. Installation tokens live ~1h and the mothership's own
 * `GitHubAppAuth` cache refuses to serve one within 5 minutes of expiry
 * (`TOKEN_SKEW_MS`), so every response has well over this window left — the memo only
 * collapses the per-GitHub-call mint chatter into one machine-API hop a minute, it can
 * never serve a lapsed token.
 */
const DELEGATED_TOKEN_MEMO_MS = 60_000

export interface GitHubDelegationClientOptions {
  /** The mothership's base URL (the same one the persistence RPC talks to). */
  baseUrl: string
  /**
   * The machine token to present, as a fixed string OR a provider read PER REQUEST — the
   * same contract as `HttpPersistenceRpcClient`, so a token cached after boot (by the
   * `/local/mothership/connect` login flow) is picked up without a restart.
   */
  token: string | (() => string | null)
  fetchImpl?: typeof fetch
}

/**
 * An {@link AppTokenSource} whose installation tokens are minted by the mothership. The
 * app-JWT paths (installation discovery / listing / the workflows-permission probe) stay
 * unavailable — exactly like local mode's `StaticTokenAppRegistry` — because the App key
 * lives only on the mothership; nothing on the mothership-mode run path uses them.
 */
export class DelegatedAppTokenSource implements AppTokenSource {
  readonly defaultAppId = ''
  private readonly memo = new Map<number, { token: string; fetchedAt: number }>()

  constructor(
    private readonly opts: GitHubDelegationClientOptions,
    private readonly now: () => number = Date.now,
  ) {}

  apps(): readonly { appId: string }[] {
    return [{ appId: '' }]
  }

  authForApp(): { appJwt(): Promise<string> } {
    return {
      appJwt: () =>
        Promise.reject(
          new Error(
            'GitHub App JWT is not available on a mothership-mode node (App key stays on the mothership)',
          ),
        ),
    }
  }

  async installationToken(
    installationId: number,
    opts?: { forceRefresh?: boolean },
  ): Promise<string> {
    if (!opts?.forceRefresh) {
      const cached = this.memo.get(installationId)
      if (cached && this.now() - cached.fetchedAt < DELEGATED_TOKEN_MEMO_MS) return cached.token
    }
    const token = await this.mint(installationId, opts?.forceRefresh === true)
    this.memo.set(installationId, { token, fetchedAt: this.now() })
    return token
  }

  // A delegated installation token carries no App-granted permissions map here (the
  // probe is an app-JWT read the laptop can't make); callers fall back to the repo
  // object's role, exactly as they do for a PAT source.
  installationPermissions(): Promise<InstallationPermissions> {
    return Promise.resolve({})
  }

  private async mint(installationId: number, forceRefresh: boolean): Promise<string> {
    const fetchImpl = this.opts.fetchImpl ?? fetch
    const machineToken = typeof this.opts.token === 'function' ? this.opts.token() : this.opts.token
    const res = await fetchImpl(
      `${this.opts.baseUrl.replace(/\/$/, '')}/internal/github/installation-token`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${machineToken ?? ''}`,
        },
        body: JSON.stringify({ installationId, ...(forceRefresh ? { forceRefresh } : {}) }),
      },
    )
    const body = (await res.json().catch(() => null)) as {
      token?: string
      error?: { message?: string }
    } | null
    if (!res.ok || typeof body?.token !== 'string') {
      throw new Error(
        body?.error?.message ?? `mothership GitHub token delegation failed (HTTP ${res.status})`,
      )
    }
    return body.token
  }
}
