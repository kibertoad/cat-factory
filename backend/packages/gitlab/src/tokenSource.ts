import type {
  GitHubInstallationRepository,
  SecretCipher,
  VcsConnectionRef,
} from '@cat-factory/kernel'

// ---------------------------------------------------------------------------
// How the GitLab client obtains a per-connection access token + base URL. Unlike
// GitHub's App-installation model, GitLab authenticates with a group/personal/OAuth
// token bound to a connection, so the seam is a simple async token lookup keyed by
// the {@link VcsConnectionRef}. A deployment supplies the concrete source (reading the
// decrypted token from the `vcs_connections` store); tests use {@link StaticGitLabTokenSource}.
// ---------------------------------------------------------------------------

export interface GitLabTokenSource {
  /** The access token to send for calls on this connection (`PRIVATE-TOKEN` header). */
  token(connection: VcsConnectionRef): Promise<string>
  /**
   * The REST API base for this connection, e.g. `https://gitlab.com/api/v4` for
   * gitlab.com or `https://gitlab.example.com/api/v4` for a self-managed instance.
   * Per-connection so different connections can target different instances.
   */
  apiBase(connection: VcsConnectionRef): string
}

/** The public gitlab.com REST v4 base. */
export const GITLAB_PUBLIC_API_BASE = 'https://gitlab.com/api/v4'

/**
 * A single-token source: every connection uses the same token + base URL. Useful for a
 * single-token deployment (mirrors local mode's PAT model) and for tests.
 *
 * The token may be given as a GETTER, because a deployment's single token is not necessarily
 * fixed for the process lifetime: local mode lets a developer install one from the sign-in screen
 * while the server runs, and a value captured at construction would pin whatever the process
 * booted with. A getter answering undefined means the deployment currently holds no token, which
 * every call REFUSES with that named cause rather than sending an empty `PRIVATE-TOKEN`.
 */
export class StaticGitLabTokenSource implements GitLabTokenSource {
  constructor(
    private readonly accessToken: string | (() => string | undefined),
    private readonly base: string = GITLAB_PUBLIC_API_BASE,
  ) {}

  async token(): Promise<string> {
    const resolved = typeof this.accessToken === 'function' ? this.accessToken() : this.accessToken
    if (!resolved) {
      throw new Error(
        'This deployment has no GitLab token yet. Sign in with a GitLab personal access token, or set GITLAB_PAT in your .env.',
      )
    }
    return resolved
  }

  apiBase(): string {
    return this.base
  }
}

/**
 * A per-workspace token source for the hosted GitLab connect flow: it resolves the sealed PAT
 * stored on the workspace's `github_installations` row (written by `VcsPatConnectionService`)
 * and decrypts it with the deployment `SecretCipher` at call time. The connection is keyed by
 * `connectionId = String(installationId)` (the synthetic id the connect flow derived from the
 * workspace id), so `Number(connectionId)` reads the row back.
 *
 * The REST base is a single deployment-level value (`GITLAB_API_BASE`) — a deployment targets
 * one GitLab instance for all its workspaces — supplied at construction. Unlike
 * {@link StaticGitLabTokenSource}, the token differs per connection, so a workspace only
 * authenticates with the credential it sealed.
 */
export class StoredGitLabTokenSource implements GitLabTokenSource {
  constructor(
    private readonly deps: {
      installations: GitHubInstallationRepository
      cipher: SecretCipher
      apiBase?: string
    },
  ) {}

  async token(connection: VcsConnectionRef): Promise<string> {
    const installationId = Number(connection.connectionId)
    if (!Number.isFinite(installationId)) {
      throw new Error(
        `GitLab connection has a non-numeric connectionId: ${connection.connectionId}`,
      )
    }
    const installation = await this.deps.installations.getByInstallationId(installationId)
    if (!installation || installation.deletedAt || !installation.accessToken) {
      throw new Error(`No GitLab credential stored for connection ${connection.connectionId}`)
    }
    return this.deps.cipher.decrypt(installation.accessToken)
  }

  apiBase(): string {
    return this.deps.apiBase ?? GITLAB_PUBLIC_API_BASE
  }
}
