import type {
  CreateRepoInput,
  GitHubProvisioningClient,
  ProvisionedRepo,
} from '../../ports/github-provisioning'
import { canCreateRepo } from './provisioning.logic'

// Orchestrates "create a repo for an org" under the two-App model (ADR 0005):
// take the direct path only when the privileged App is installed on the org AND
// the installation actually holds `Administration: write`; otherwise report
// `delegated` so the caller keeps the existing manual flow (the UI's "create on
// GitHub" button). There is no server-side fallback action — restricted orgs
// behave exactly as they did before this tier existed.

/** Why a repo wasn't created directly (informational; the caller delegates regardless). */
export type DelegationReason =
  | 'app_not_installed' // privileged App isn't installed on the org
  | 'insufficient_permissions' // installed, but without Administration: write
  | 'forbidden' // org policy refused the create (403)
  | 'already_exists' // a repo by that name already exists (422)

export type ProvisionResult =
  | { status: 'created'; repo: ProvisionedRepo }
  | { status: 'delegated'; reason: DelegationReason }

export interface RepoProvisioningServiceDependencies {
  /** Backed by the *privileged* App's credentials (resolved per-org by the worker). */
  client: GitHubProvisioningClient
}

/** Sniff an HTTP status without coupling to a specific error class. */
function statusOf(err: unknown): number | undefined {
  return (err as { status?: number } | null)?.status
}

export class RepoProvisioningService {
  constructor(private readonly deps: RepoProvisioningServiceDependencies) {}

  /**
   * Create `input.name` under `input.org` when the privileged App can; otherwise
   * `delegated`. The capability check is proactive (skips a guaranteed-403 round
   * trip); a live 403 or a 422 "already exists" also resolve to `delegated` so
   * the caller's manual/existing-repo path takes over.
   */
  async provision(input: CreateRepoInput): Promise<ProvisionResult> {
    const installationId = await this.deps.client.getOrgInstallationId(input.org)
    if (installationId === null) return { status: 'delegated', reason: 'app_not_installed' }

    const permissions = await this.deps.client.getGrantedPermissions(installationId)
    if (!canCreateRepo(permissions)) {
      return { status: 'delegated', reason: 'insufficient_permissions' }
    }

    try {
      const repo = await this.deps.client.createRepoInOrg(installationId, input)
      return { status: 'created', repo }
    } catch (err) {
      const status = statusOf(err)
      if (status === 403) return { status: 'delegated', reason: 'forbidden' }
      if (status === 422) return { status: 'delegated', reason: 'already_exists' }
      throw err
    }
  }
}
