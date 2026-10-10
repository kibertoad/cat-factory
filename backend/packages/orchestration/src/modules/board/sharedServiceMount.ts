import type {
  Block,
  BlockRepository,
  Clock,
  GitHubRepo,
  GroupCacheHandle,
  RepoProjectionRepository,
  Service,
  ServiceRepository,
  WorkspaceMountRepository,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import { applyMountLayout, ValidationError } from '@cat-factory/kernel'
import type { BoardChangeReason } from './board.logic.js'
import type { ServiceRepoLinkage, SharedServicePolicy } from './serviceRepoLinkage.js'

// The repo side of `BoardService.addServiceFromRepo`: the account-wide dedupe that MOUNTS an
// existing whole-repo service rather than minting a rival, and the repository-wide monorepo flag
// the same request may flip.
//
// Extracted from `BoardService` following the established pattern (a small deps object of bound
// callbacks, thin delegates left behind). The two belong together because they are the pair a
// create has to ORDER correctly: the flag is repository-wide state that outlives this service, so
// it may only be written once every refusal the mount can raise has already had its chance.

export interface SharedServiceMountDeps {
  blockRepository: BlockRepository
  workspaceRepository: WorkspaceRepository
  clock: Clock
  /** Optional: in-org service sharing unwired means nothing to dedupe against. */
  serviceRepository?: ServiceRepository
  /** Optional: without mounts a shared service cannot be placed on a second board. */
  workspaceMountRepository?: WorkspaceMountRepository
  /** Optional: absent ⇒ no VCS integration, so no monorepo flag to write. */
  repoProjectionRepository?: RepoProjectionRepository
  /** Optional projection cache, invalidated per workspace when the flag moves. */
  repoProjectionCache?: GroupCacheHandle<GitHubRepo[]>
  /** The service's own board-event emitter, bound so the fan-out stays one implementation. */
  emitBoardChanged(
    workspaceId: string,
    change: { reason: BoardChangeReason; blockId: string },
  ): Promise<void>
}

export function createSharedServiceMount(deps: SharedServiceMountDeps) {
  /**
   * The account's existing WHOLE-REPO (non-monorepo, no subdirectory) service for a repo, or null.
   * Account-scoped so it dedups a shared repo across the org regardless of which installation each
   * board reached it through. Requires the service repo to be wired.
   */
  async function findAccountWholeRepoService(
    workspaceId: string,
    repoGithubId: number,
  ): Promise<Service | null> {
    if (!deps.serviceRepository) return null
    const account = (await deps.workspaceRepository.accountOf(workspaceId)) ?? null
    const services = await deps.serviceRepository.listByAccount(account)
    return services.find((s) => s.repoGithubId === repoGithubId && !s.directory) ?? null
  }

  /**
   * Mount an EXISTING account-owned service onto `workspaceId` and return its frame block —
   * the shared-service path taken by `addServiceFromRepo` when the repo already backs a
   * service. Mounting (not re-creating) is how two boards in one org work on the same service
   * with a shared subtree/task list. Same-org only; idempotent when already mounted here.
   *
   * `policy` decides what a service homed on ANOTHER board means to this caller: the app mounts
   * it and renders it as part of the composed board, while a caller whose every read is
   * workspace-scoped cannot address the returned frame at all. See {@link SharedServicePolicy}.
   */
  async function mountExistingService(
    workspaceId: string,
    service: Service,
    policy: SharedServicePolicy,
    position?: { x: number; y: number },
  ): Promise<Block> {
    if (!deps.workspaceMountRepository) {
      throw new ValidationError('This repository is already linked to a board service')
    }
    // A service is shared strictly within its account — never mount one from another org.
    const account = await deps.workspaceRepository.accountOf(workspaceId)
    if ((account ?? null) !== (service.accountId ?? null)) {
      throw new ValidationError(
        'This repository is already linked to a service in another organization',
      )
    }
    const home = await deps.blockRepository.findById(service.frameBlockId)
    if (!home) {
      // The service's frame block is gone (a stale orphan). Surface a clean error rather than
      // mounting a dead frame; the delete cascade normally reclaims such orphans.
      throw new ValidationError('This repository is already linked to a board service')
    }
    if (policy === 'refuse' && home.workspaceId !== workspaceId) {
      // Refused BEFORE the mount is written: a caller that cannot address the frame gains nothing
      // from the board silently acquiring a service it asked to CREATE, and would then have to
      // undo a mount it never asked for through a surface that cannot see it.
      throw new ValidationError(
        'This repository already backs a service on another board in this organization',
        { reason: 'repo_service_homed_elsewhere' },
      )
    }
    let mount = await deps.workspaceMountRepository.get(workspaceId, service.id)
    if (!mount) {
      const existingMounts = await deps.workspaceMountRepository.listByWorkspace(workspaceId)
      // Lay a new mount out on a 5-wide grid (matching ServiceMountService) when no explicit
      // position is given, so shared services don't pile onto the same point.
      const n = existingMounts.length
      mount = {
        workspaceId,
        serviceId: service.id,
        position: position ?? { x: 80 + (n % 5) * 48, y: 80 + Math.floor(n / 5) * 48 },
        size: null,
        createdAt: deps.clock.now(),
      }
      await deps.workspaceMountRepository.upsert(mount)
      // Fan out from the frame's HOME so every board mounting the shared service refreshes. A
      // FRAME, and each target board reads its own mount, so there is no payload to carry.
      await deps.emitBoardChanged(home.workspaceId, {
        reason: 'block-added',
        blockId: home.block.id,
      })
    }
    // The frame block is the one homed on ANOTHER board, carrying that board's coordinates —
    // return it placed where THIS board just mounted it, or the SPA drops the imported service
    // at the home board's spot until the next full refresh.
    return applyMountLayout(home.block, mount)
  }

  /**
   * Write the repository's monorepo flag, once the create it rides along with is going to happen.
   *
   * A no-op when the request asked for the flag already stored, which is the ordinary case: the
   * app sends the flag with every add, and only the one that CHANGES it owes a write. Mutates the
   * caller's `repo` alongside the row so the rest of the create reads one value.
   */
  async function persistMonorepoFlag(
    workspaceId: string,
    repo: GitHubRepo,
    linkage: ServiceRepoLinkage,
  ): Promise<void> {
    if (!linkage.flagChanged || !deps.repoProjectionRepository) return
    await deps.repoProjectionRepository.setMonorepo(workspaceId, repo.githubId, linkage.isMonorepo)
    repo.isMonorepo = linkage.isMonorepo
    // The monorepo flag decides whether `resolveRepoTarget` hands agents the service
    // subdirectory, so drop the cached projection or a warmed entry keeps serving the
    // old flag until its TTL — the agent would run at the repo root instead of the pin.
    await deps.repoProjectionCache?.invalidateGroup(workspaceId)
  }

  return { findAccountWholeRepoService, mountExistingService, persistMonorepoFlag }
}
