import type {
  CreateRepoInput,
  GitHubProvisioningClient,
  ProvisionedRepo,
} from '../../ports/github-provisioning'
import { canCreateRepo } from './provisioning.logic'

// Orchestrates "create a repo for an org" under the two-App model (ADR 0005):
// take the direct path only when the installation actually holds
// `Administration: write`, otherwise delegate to a fallback. The capability
// check is proactive (skips a guaranteed-403 round trip) and a live 403 routes
// to the same fallback as a safety net.

/** Why a create request could not be performed directly. */
export type ProvisionFallbackReason = 'insufficient_permissions' | 'forbidden'

/**
 * Invoked when the chosen App cannot create the repo directly — either the
 * restricted tier lacks `Administration: write`, or GitHub rejected the create
 * with a 403 despite the proactive check. Implementations queue the request for
 * an org-admin OAuth flow, open a tracking issue, notify a human, etc., and
 * report where it landed.
 */
export type RepoProvisionFallback = (
  request: CreateRepoInput,
  reason: ProvisionFallbackReason,
) => Promise<ProvisionResult>

export interface ProvisionResult {
  status: 'created' | 'delegated'
  /** Present when `status === 'created'`. */
  repo?: ProvisionedRepo
  /** Free-form note describing where a delegated request landed. */
  detail?: string
}

export interface RepoProvisioningServiceDependencies {
  /**
   * The provisioning client to act through. In the worker this is backed by the
   * privileged App's credentials (resolved per-org via the App registry); the
   * service stays agnostic to how the client was chosen.
   */
  client: GitHubProvisioningClient
  fallback: RepoProvisionFallback
}

/** Sniff an HTTP 403 without coupling to a specific error class. */
function isForbidden(err: unknown): boolean {
  return (err as { status?: number } | null)?.status === 403
}

export class RepoProvisioningService {
  constructor(private readonly deps: RepoProvisioningServiceDependencies) {}

  /**
   * Create `input.name` under `input.org`. Guards the direct path on the
   * installation's *granted* permissions, and falls back to delegation when the
   * grant is missing or GitHub forbids the create.
   */
  async provision(installationId: number, input: CreateRepoInput): Promise<ProvisionResult> {
    const permissions = await this.deps.client.getGrantedPermissions(installationId)
    if (!canCreateRepo(permissions)) {
      return this.deps.fallback(input, 'insufficient_permissions')
    }
    try {
      const repo = await this.deps.client.createRepoInOrg(installationId, input)
      return { status: 'created', repo }
    } catch (err) {
      if (isForbidden(err)) return this.deps.fallback(input, 'forbidden')
      throw err
    }
  }
}
