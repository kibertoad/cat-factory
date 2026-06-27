// ---------------------------------------------------------------------------
// GitHubProvisioningClient port: the *privileged* slice of the GitHub REST API
// used to create repositories and to introspect what an installation may
// actually do. Deliberately separate from `GitHubClient` (the read/write slice
// every workspace uses) because repo creation needs the elevated
// `Administration: write` grant that only the privileged App tier carries — see
// ADR 0005. Splitting the port keeps the common client implementable without
// the elevated grant, and lets the provisioner reason about capability *before*
// it acts rather than discovering a 403 mid-flight.
// ---------------------------------------------------------------------------

// `ProvisionedRepo` is the wire-returned shape, so its single source of truth is the
// valibot schema in `@cat-factory/contracts` (`provisionedRepoSchema`); re-exported
// here so the port and the createRepo route contract can't drift.
import type { ProvisionedRepo } from '@cat-factory/contracts'
export type { ProvisionedRepo }

/**
 * The permissions an installation token was actually granted, as reported by
 * `POST /app/installations/{id}/access_tokens`. This is the intersection of the
 * App's requested permissions and what the installing account approved, so it —
 * not the App's registration — is the source of truth for "can this credential
 * do X". Values are GitHub's permission levels; an absent key means "not
 * granted".
 */
export interface InstallationPermissions {
  /** Repository administration — required to create repositories. */
  administration?: 'read' | 'write'
  /** Organization-level administration, granted to some App profiles. */
  organization_administration?: 'read' | 'write'
  contents?: 'read' | 'write'
  [permission: string]: 'read' | 'write' | 'admin' | undefined
}

export interface CreateRepoInput {
  /** The organization login to create the repository under. */
  org: string
  name: string
  private?: boolean
  description?: string
  /** Seed the repo with an initial commit (so it has a default branch). */
  autoInit?: boolean
}

export interface GitHubProvisioningClient {
  /**
   * The permissions the installation token actually carries. Read this before a
   * privileged action so the caller can choose a path (or refuse) without
   * provoking a guaranteed 403.
   */
  getGrantedPermissions(installationId: number): Promise<InstallationPermissions>
  /**
   * Create a repository under an organization. Requires the installation to hold
   * `administration: write`; otherwise GitHub answers 403.
   */
  createRepoInOrg(installationId: number, input: CreateRepoInput): Promise<ProvisionedRepo>
}
