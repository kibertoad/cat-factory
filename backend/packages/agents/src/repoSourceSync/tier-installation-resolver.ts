import type { GitHubInstallationRepository, WorkspaceRepository } from '@cat-factory/kernel'
import type { FragmentOwnerKind } from '@cat-factory/kernel'

// The ONE implementation of "which GitHub installation reads this tier's repos", shared by
// both runtime facades for both repo-sourced content libraries (prompt fragments + Claude
// Skills), so the resolution rules cannot drift between them.
//
// The workspace tier is a direct binding (`github_installations.workspace_id`). The account
// tier is where the naive `installation.accountId === accountId` match breaks: that column
// is null for a per-workspace PAT connect (deliberately unshared), and local PAT mode's
// synthetic rows stamp it with the PAT's GitHub account id — so an account-scope source
// sync failed with "No GitHub installation is available for this scope" on exactly the
// deployments where the user could already browse the repo. The account tier therefore
// falls back to the installations of the account's OWN boards (one batched
// `listByAccount` read — never a per-installation point lookup), which is also the
// stricter scoping: an installation reachable through one of the account's boards is,
// by construction, a credential that account already uses.

export interface TierInstallationResolverDependencies {
  installations: GitHubInstallationRepository
  workspaces: WorkspaceRepository
}

export interface TierInstallationResolvers {
  /** The installation bound to a workspace, or null when the board never connected one. */
  forWorkspace(workspaceId: string): Promise<number | null>
  /**
   * An installation the account can read repos through: the row bound to the account
   * directly when one exists, else any active installation belonging to one of the
   * account's boards.
   */
  forAccount(accountId: string): Promise<number | null>
  /** The {@link forWorkspace}/{@link forAccount} pair keyed by a fragment tier. */
  forOwner(ownerKind: FragmentOwnerKind, ownerId: string): Promise<number | null>
}

export function createTierInstallationResolvers(
  deps: TierInstallationResolverDependencies,
): TierInstallationResolvers {
  const forWorkspace = async (workspaceId: string): Promise<number | null> =>
    (await deps.installations.getByWorkspace(workspaceId))?.installationId ?? null

  const forAccount = async (accountId: string): Promise<number | null> => {
    const active = await deps.installations.listActive()
    const direct = active.find((i) => i.accountId === accountId)
    if (direct) return direct.installationId
    const boards = await deps.workspaces.listByAccount(accountId)
    const boardIds = new Set(boards.map((w) => w.id))
    const viaBoard = active.find((i) => boardIds.has(i.workspaceId))
    if (viaBoard) return viaBoard.installationId
    // Local PAT mode provisions a board's synthetic installation lazily on its FIRST
    // `getByWorkspace` read, so a board never probed has no active row yet. One point read
    // on one of the account's boards covers that (every board resolves to the same PAT
    // there); on a hosted facade a genuinely connected installation is already active, so
    // this stays a miss for an account that truly never connected anything.
    const [board] = boards
    return board ? forWorkspace(board.id) : null
  }

  return {
    forWorkspace,
    forAccount,
    forOwner: (ownerKind, ownerId) =>
      ownerKind === 'workspace' ? forWorkspace(ownerId) : forAccount(ownerId),
  }
}
