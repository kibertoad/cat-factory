import { type AppTier, type TierConfig, resolveAppTier } from '@cat-factory/core'
import type { GitHubAppAuth } from './GitHubAppAuth'

// The two-App resolver (ADR 0005). A single GitHub App has one permission set
// across every installation, so to run sensitive orgs on a minimal grant while
// still creating repos for trusted orgs we register *two* Apps and pick between
// them per org:
//   - `privileged`  — carries `Administration: write`; used for orgs explicitly
//                     allow-listed for direct repo creation.
//   - `restricted`  — the minimal-permission default; used everywhere else, so a
//                     leak of its key can never create or administer repos.
//
// Resolution fails closed: an org is privileged only when explicitly listed
// (see `resolveAppTier`), otherwise it gets the restricted credentials.

export interface GitHubAppRegistryDependencies {
  restricted: GitHubAppAuth
  /** Absent when no privileged App is configured — then every org is restricted. */
  privileged?: GitHubAppAuth
  tierConfig: TierConfig
}

export class GitHubAppRegistry {
  constructor(private readonly deps: GitHubAppRegistryDependencies) {}

  /** The tier an org resolves to, downgrading to restricted if no privileged App exists. */
  tierFor(orgLogin: string): AppTier {
    const tier = resolveAppTier(orgLogin, this.deps.tierConfig)
    return tier === 'privileged' && this.deps.privileged ? 'privileged' : 'restricted'
  }

  /** The App credentials to authenticate with for an org. */
  authFor(orgLogin: string): GitHubAppAuth {
    return this.tierFor(orgLogin) === 'privileged'
      ? // Non-null: tierFor only returns 'privileged' when this is set.
        this.deps.privileged!
      : this.deps.restricted
  }
}
