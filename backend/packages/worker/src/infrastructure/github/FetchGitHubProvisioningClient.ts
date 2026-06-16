import type {
  CreateRepoInput,
  GitHubProvisioningClient,
  InstallationPermissions,
  ProvisionedRepo,
} from '@cat-factory/core'
import type { GitHubAppAuth } from './GitHubAppAuth'

// `fetch`-based adapter for the privileged provisioning slice (ADR 0005). Bound
// to the *privileged* App's `GitHubAppAuth` — a separate registration from the
// one a workspace binds to, so it discovers its own per-org installation id via
// the app JWT. Mirrors `FetchGitHubClient`'s Web-Crypto/`fetch`-only approach
// (no Octokit; see ADR 0001).

const USER_AGENT = 'cat-factory'
const API_VERSION = '2022-11-28'
const ACCEPT = 'application/vnd.github+json'

export interface FetchGitHubProvisioningClientDependencies {
  auth: GitHubAppAuth
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

  async getOrgInstallationId(org: string): Promise<number | null> {
    // App-JWT call: where is *this* App installed for the org? 404 = not installed.
    const jwt = await this.deps.auth.appJwt()
    const res = await fetch(`${this.deps.apiBase}/orgs/${encodeURIComponent(org)}/installation`, {
      headers: {
        authorization: `Bearer ${jwt}`,
        accept: ACCEPT,
        'user-agent': USER_AGENT,
        'x-github-api-version': API_VERSION,
      },
    })
    if (res.status === 404) return null
    if (!res.ok) {
      throw new GitHubHttpError(res.status, `Failed to resolve installation for ${org}`)
    }
    const body = (await res.json()) as { id: number }
    return body.id
  }

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
