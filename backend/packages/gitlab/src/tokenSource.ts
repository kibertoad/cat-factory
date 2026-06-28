import type { VcsConnectionRef } from '@cat-factory/kernel'

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
 * A fixed-token source: every connection uses the same token + base URL. Useful for a
 * single-token deployment (mirrors local mode's PAT model) and for tests.
 */
export class StaticGitLabTokenSource implements GitLabTokenSource {
  constructor(
    private readonly accessToken: string,
    private readonly base: string = GITLAB_PUBLIC_API_BASE,
  ) {}

  async token(): Promise<string> {
    return this.accessToken
  }

  apiBase(): string {
    return this.base
  }
}
