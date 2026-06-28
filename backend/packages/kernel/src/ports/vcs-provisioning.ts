// ---------------------------------------------------------------------------
// VcsProvisioningClient port: the *privileged* slice of a VCS host's API used to
// create repositories and to introspect what a connection may actually do. The
// neutral successor to `GitHubProvisioningClient`, keyed by a {@link VcsConnectionRef}
// instead of a numeric installation id.
//
// Deliberately separate from `VcsClient` (the read/write slice every workspace uses)
// because repo creation needs an elevated grant that only a privileged credential
// carries (on GitHub, the `Administration: write` App tier — see ADR 0005). Splitting
// the port keeps the common client implementable without the elevated grant, and lets
// the provisioner reason about capability *before* it acts rather than discovering a
// 403 mid-flight.
// ---------------------------------------------------------------------------

import type { ProvisionedRepo } from '@cat-factory/contracts'
import type { VcsConnectionRef } from '../domain/vcs-types.js'
import type { CreateRepoInput, InstallationPermissions } from './github-provisioning.js'

export type { ProvisionedRepo, CreateRepoInput, InstallationPermissions }

export interface VcsProvisioningClient {
  /**
   * The permissions the connection's token actually carries. Read this before a
   * privileged action so the caller can choose a path (or refuse) without provoking
   * a guaranteed 403.
   */
  getGrantedPermissions(connection: VcsConnectionRef): Promise<InstallationPermissions>
  /**
   * Create a repository under an organization/group. Requires the connection to hold
   * the elevated administration grant; otherwise the host answers 403.
   */
  createRepoInOrg(connection: VcsConnectionRef, input: CreateRepoInput): Promise<ProvisionedRepo>
}
