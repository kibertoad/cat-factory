import type { InstallationPermissions } from '@cat-factory/kernel'
import type { AppTokenSource } from './GitHubAppRegistry.js'
import { InstallationTokenCache, installationTokenKey } from './installationTokenCache.js'

// The client side of mothership-mode GitHub token delegation. A mothership-mode local
// node has no GitHub App key (product decision: the App private key never reaches the
// laptop) and, without a PAT, no GitHub credential at all — yet its agent containers,
// gates, and RepoFiles ops must reach GitHub. This {@link AppTokenSource} closes that
// gap by minting each installation token FROM THE MOTHERSHIP over the machine API
// (`POST /internal/github/installation-token`, served by `githubDelegationController`),
// so the shared `FetchGitHubClient` — and the executor's push-token mint — run on the
// laptop unchanged, on short-lived, REPO-SCOPED variants of the installation tokens the
// mothership's own engine uses (narrowed to the repos the mothership projects for the
// installation).

/**
 * How long a delegated installation token is served from the in-process memo before the
 * mothership is asked again. It is far shorter than the ~1h a GitHub token lives, so the memo
 * can never serve a lapsed one even though this side never reads the real expiry: the
 * mothership answers with a token whose remaining lifetime it alone knows. The window exists to
 * collapse the per-GitHub-call chatter into at most one machine-API hop a minute per scope,
 * which also keeps a legitimate node far under the mothership's per-node mint rate limit.
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
  private readonly memo = new InstallationTokenCache<string>()

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
    opts?: { forceRefresh?: boolean; repositoryIds?: number[] },
  ): Promise<string> {
    // The memo is keyed by the SCOPE, not the installation: a container dispatch asks for a token
    // narrowed to the repos its run resolved, and serving that from an installation-keyed entry
    // would hand one run another run's scope, too wide or too narrow and silently either way.
    // A key per distinct scope keeps the mothership's per-node rate limit comfortable, because a
    // pipeline's dispatches repeat the same handful of repo sets. Lapsed entries are evicted (see
    // {@link InstallationTokenCache}), so keying by scope cannot turn a map bounded by
    // installations into one that grows for the lifetime of a long-running node.
    const key = installationTokenKey(installationId, opts?.repositoryIds)
    const now = this.now()
    if (!opts?.forceRefresh) {
      const cached = this.memo.get(key, now)
      if (cached) return cached
    }
    const token = await this.mint(installationId, opts?.forceRefresh === true, opts?.repositoryIds)
    this.memo.set(key, token, now + DELEGATED_TOKEN_MEMO_MS, now)
    return token
  }

  // A delegated installation token carries no App-granted permissions map here (the
  // probe is an app-JWT read the laptop can't make); callers fall back to the repo
  // object's role, exactly as they do for a PAT source.
  installationPermissions(): Promise<InstallationPermissions> {
    return Promise.resolve({})
  }

  private async mint(
    installationId: number,
    forceRefresh: boolean,
    repositoryIds: number[] | undefined,
  ): Promise<string> {
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
        body: JSON.stringify({
          installationId,
          ...(forceRefresh ? { forceRefresh } : {}),
          // The mothership INTERSECTS this with the repos it links for the installation, so
          // asking narrows and can never widen. Omitted ⇒ the whole linked set, which is what
          // the engine's own gate/merge calls want.
          ...(repositoryIds?.length ? { repositoryIds } : {}),
        }),
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
