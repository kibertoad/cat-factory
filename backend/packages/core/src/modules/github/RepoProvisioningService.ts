import type {
  CreateRepoInput,
  GitHubProvisioningClient,
  ProvisionedRepo,
} from '../../ports/github-provisioning'
import { canCreateRepo } from './provisioning.logic'

// Orchestrates "create a repo" under the two-App model (ADR 0005). The caller
// passes the workspace's bound installation id — for a privileged-tier org that
// installation belongs to the privileged App and carries `Administration: write`,
// so creation works; for everyone else the grant is absent and we report
// `delegated`, leaving the existing manual flow (the UI's "create on GitHub"
// button). There is no server-side fallback action.

/** Why a repo wasn't created directly (informational; the caller delegates regardless). */
export type DelegationReason =
  | 'insufficient_permissions' // the installation lacks Administration: write
  | 'forbidden' // org policy refused the create (403)
  | 'already_exists' // a repo by that name already exists (422)

export type ProvisionResult =
  | { status: 'created'; repo: ProvisionedRepo }
  | { status: 'delegated'; reason: DelegationReason }

export interface RepoProvisioningServiceDependencies {
  /** Mints tokens for the installation's owning App (the registry resolver). */
  client: GitHubProvisioningClient
}

/** Sniff an HTTP status without coupling to a specific error class. */
function statusOf(err: unknown): number | undefined {
  return (err as { status?: number } | null)?.status
}

export class RepoProvisioningService {
  constructor(private readonly deps: RepoProvisioningServiceDependencies) {}

  /**
   * Create `input.name` under `input.org` using `installationId`'s credentials.
   * Guards proactively on the installation's *granted* permissions (skips a
   * guaranteed-403 round trip); a live 403 or a 422 "already exists" also resolve
   * to `delegated` so the caller's manual/existing-repo path takes over.
   */
  async provision(installationId: number, input: CreateRepoInput): Promise<ProvisionResult> {
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
