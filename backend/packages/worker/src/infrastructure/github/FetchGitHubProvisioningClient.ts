import type {
  CreateRepoInput,
  GitHubProvisioningClient,
  InstallationPermissions,
  ProvisionedRepo,
} from '@cat-factory/core'
import type { GitHubAppAuth } from './GitHubAppAuth'

// `fetch`-based adapter for the privileged provisioning slice (ADR 0005). Bound
// to a single `GitHubAppAuth` — the worker resolves which App to use per-org via
// `GitHubAppRegistry` and constructs this client with the chosen credentials, so
// the adapter itself stays unaware of tiers. Mirrors `FetchGitHubClient`'s
// Web-Crypto/`fetch`-only approach (no Octokit; see ADR 0001).

const USER_AGENT = 'cat-factory'
const API_VERSION = '2022-11-28'
const ACCEPT = 'application/vnd.github+json'

export interface FetchGitHubProvisioningClientDependencies {
  auth: GitHubAppAuth
  apiBase: string
}

/** A 403 carrier the core's `RepoProvisioningService` recognises to trigger fallback. */
class GitHubForbiddenError extends Error {
  readonly status = 403
}

interface CreatedRepoResponse {
  id: number
  owner: { login: string }
  name: string
  default_branch: string | null
  private: boolean
}

export class FetchGitHubProvisioningClient implements GitHubProvisioningClient {
  constructor(private readonly deps: FetchGitHubProvisioningClientDependencies) {}

  getGrantedPermissions(installationId: number): Promise<InstallationPermissions> {
    return this.deps.auth.installationPermissions(installationId)
  }

  async createRepoInOrg(installationId: number, input: CreateRepoInput): Promise<ProvisionedRepo> {
    const token = await this.deps.auth.installationToken(installationId)
    const res = await fetch(`${this.deps.apiBase}/orgs/${encodeURIComponent(input.org)}/repos`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        accept: ACCEPT,
        'user-agent': USER_AGENT,
        'x-github-api-version': API_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: input.name,
        private: input.private ?? true,
        description: input.description,
        auto_init: input.autoInit ?? false,
      }),
    })

    if (res.status === 403) {
      // Org policy (or a missing grant the proactive check couldn't see) refused
      // it — surface as the recognised 403 so the service delegates to fallback.
      throw new GitHubForbiddenError(`Forbidden creating ${input.org}/${input.name}`)
    }
    if (!res.ok) {
      throw new Error(`Failed to create repo ${input.org}/${input.name} (HTTP ${res.status})`)
    }

    const body = (await res.json()) as CreatedRepoResponse
    return {
      githubId: body.id,
      owner: body.owner.login,
      name: body.name,
      defaultBranch: body.default_branch,
      private: body.private,
    }
  }
}
