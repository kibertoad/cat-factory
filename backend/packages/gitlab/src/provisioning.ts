import type {
  CreateRepoInput,
  InstallationPermissions,
  ProvisionedRepo,
  VcsConnectionRef,
  VcsProvisioningClient,
} from '@cat-factory/kernel'
import { describeVcsApiError } from '@cat-factory/kernel'
import type { GitLabTokenSource } from './tokenSource.js'
import { GitLabApiError } from './FetchGitLabClient.js'

// ---------------------------------------------------------------------------
// GitLab repo (project) provisioning — the privileged slice. Creates a project under a
// group/namespace. GitLab has no GitHub-style per-installation permission introspection
// endpoint, so capability is discovered by attempting the create and surfacing a 403.
// ---------------------------------------------------------------------------

export interface GitLabProvisioningDependencies {
  tokenSource: GitLabTokenSource
  fetchImpl?: typeof fetch
}

export class GitLabProvisioningClient implements VcsProvisioningClient {
  constructor(private readonly deps: GitLabProvisioningDependencies) {}

  async getGrantedPermissions(connection: VcsConnectionRef): Promise<InstallationPermissions> {
    // GitLab token scopes (e.g. `api`) aren't readable from a permission endpoint the way a
    // GitHub installation token reports its granted set. A token that can hit the API can
    // generally create projects in a namespace it owns; the actual create surfaces a 403
    // otherwise. Report the optimistic grant so the provisioner attempts the create.
    void connection
    return { administration: 'write', contents: 'write' }
  }

  async createRepoInOrg(
    connection: VcsConnectionRef,
    input: CreateRepoInput,
  ): Promise<ProvisionedRepo> {
    const namespaceId = await this.resolveNamespaceId(connection, input.org)
    const body: Record<string, unknown> = {
      name: input.name,
      path: input.name,
      visibility: input.private === false ? 'public' : 'private',
      ...(namespaceId !== null ? { namespace_id: namespaceId } : {}),
      ...(input.description ? { description: input.description } : {}),
      ...(input.autoInit ? { initialize_with_readme: true } : {}),
    }
    const json = await this.request(connection, '/projects', 'POST', body)
    const p = (json ?? {}) as {
      id?: number
      path?: string
      name?: string
      default_branch?: string | null
      visibility?: string
    }
    return {
      githubId: p.id ?? 0,
      owner: input.org,
      name: p.path ?? input.name,
      defaultBranch: p.default_branch ?? null,
      private: p.visibility !== 'public',
    }
  }

  /** Resolve a group/namespace full-path to its numeric id, or null for a user namespace. */
  private async resolveNamespaceId(
    connection: VcsConnectionRef,
    org: string,
  ): Promise<number | null> {
    try {
      const json = await this.request(connection, `/namespaces/${encodeURIComponent(org)}`, 'GET')
      const id = (json as { id?: number }).id
      return typeof id === 'number' ? id : null
    } catch (err) {
      // No matching namespace (or no access) → let the create default to the token user's
      // own namespace rather than failing the resolution step.
      if (err instanceof GitLabApiError && err.status === 404) return null
      throw err
    }
  }

  private async request(
    connection: VcsConnectionRef,
    path: string,
    method: string,
    body?: unknown,
  ): Promise<unknown> {
    const apiBase = this.deps.tokenSource.apiBase(connection)
    const token = await this.deps.tokenSource.token(connection)
    const headers: Record<string, string> = {
      'private-token': token,
      accept: 'application/json',
      'user-agent': 'cat-factory',
    }
    if (body !== undefined) headers['content-type'] = 'application/json'
    const fetchImpl = this.deps.fetchImpl ?? fetch
    const res = await fetchImpl(`${apiBase}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new GitLabApiError(
        res.status,
        describeVcsApiError({
          provider: 'gitlab',
          status: res.status,
          method,
          url: `${apiBase}${path}`,
          body: text.slice(0, 300),
          rateLimited: res.status === 429,
        }),
      )
    }
    return res.status === 204 ? null : await res.json().catch(() => null)
  }
}
