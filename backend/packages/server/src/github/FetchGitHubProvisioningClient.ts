import type {
  CreateRepoInput,
  GitHubProvisioningClient,
  InstallationPermissions,
  ProvisionedRepo,
} from '@cat-factory/kernel'
import type { GitHubAppRegistry } from './GitHubAppRegistry.js'

// `fetch`-based adapter for the privileged provisioning slice (ADR 0005). Routes
// token minting through the registry, so it acts as whichever App owns the
// installation passed in — for a privileged-tier org that's the privileged App
// carrying `Administration: write`. Mirrors `FetchGitHubClient`'s
// Web-Crypto/`fetch`-only approach (no Octokit; see ADR 0001). Runtime-neutral and
// shared by every facade so a deployment can provision repos regardless of runtime.

const USER_AGENT = 'cat-factory'
const API_VERSION = '2022-11-28'
const ACCEPT = 'application/vnd.github+json'

export interface FetchGitHubProvisioningClientDependencies {
  registry: GitHubAppRegistry
  apiBase: string
}

/** An HTTP error that carries its status so the core can branch (403 / 422 → delegate). */
class GitHubHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
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
    return this.deps.registry.installationPermissions(installationId)
  }

  async createRepoInOrg(installationId: number, input: CreateRepoInput): Promise<ProvisionedRepo> {
    const token = await this.deps.registry.installationToken(installationId)
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

    // Status-carrying errors so the core delegates on 403 (org policy) / 422
    // (name already exists) and surfaces anything else as a hard failure.
    if (!res.ok) {
      throw new GitHubHttpError(
        res.status,
        `Failed to create repo ${input.org}/${input.name} (HTTP ${res.status})`,
      )
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
