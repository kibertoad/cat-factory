import type { AddTaskInput, BlockEditAuthority, GitHubRepo } from '@cat-factory/contracts'
import type {
  Block,
  BlockRepository,
  BlockStatus,
  RepoProjectionRepository,
  ServiceRepository,
} from '@cat-factory/kernel'
import { NotFoundError, ValidationError } from '@cat-factory/kernel'
import { serviceOf } from './board.logic.js'

// The external `/api/v1` board surface (see PublicApiController), extracted from BoardService as a
// cohesive collaborator: one small deps object of bound call-backs, with the service keeping thin
// delegate methods. It is its own unit because the whole group shares one non-obvious contract the
// rest of the board does NOT have — a key's OWN workspace only.
//
// Every read here is STRICTLY scoped to `workspaceId` and goes through the workspace-scoped
// repository reads, which never surface a service merely MOUNTED from another workspace (those are
// homed elsewhere), so an external key can only ever touch its own board. They key on the FRAME
// BLOCK id (`serviceId` in the wire contract) and always exclude the headless `internal` anchors,
// exactly as the board snapshot does.

/**
 * Whether a repository is already spoken for, and by what.
 *
 * Its own type rather than fields on {@link PublicRepoOption}, because the same judgement is owed
 * about a repository this workspace has NOT linked: that one has no projection row to carry it, and
 * a second derivation is how the discovery read and the list come to disagree about whether a
 * repository is free.
 */
export interface RepoUse {
  /**
   * The frame block id of the WHOLE-REPO service this repository already backs ON THIS BOARD, or
   * null.
   *
   * Null for a monorepo even when its subdirectories back services, because a monorepo can back
   * more: the field answers "is this choice already spent", and for a monorepo it never is.
   */
  serviceBlockId: string | null
  /**
   * True when the repository already backs a whole-repo service homed on ANOTHER board of the
   * account, so nothing on a workspace-scoped surface can name it.
   *
   * The third state the pair `serviceBlockId: string` / `serviceBlockId: null` cannot express, and
   * the one a caller most needs: the choice IS spent (the create refuses it, since the frame it
   * would answer with is one this key could neither list nor file a task under), but there is no
   * id here that would address the service. Reporting it as a plain `null` said the opposite of
   * both facts, and steered a caller straight into the refusal.
   */
  linkedElsewhere: boolean
}

/** That verdict per provider repo id, for a batch of repositories asked about at once. */
export type RepoUseByRepoId = ReadonlyMap<number, RepoUse>

/** A repository the workspace can back a service with, and the service already backing it. */
export interface PublicRepoOption extends RepoUse {
  repo: GitHubRepo
}

export interface PublicBoardReadsDeps {
  blockRepository: BlockRepository
  /** The workspace's projected repositories; absent ⇒ no VCS integration wired on this facade. */
  repoProjectionRepository?: RepoProjectionRepository
  /** The account-owned services frames map onto; absent ⇒ nothing can report a repo's service. */
  serviceRepository?: ServiceRepository
  /** The workspace's owning account, for the account-scoped service dedupe the create applies. */
  accountOf(workspaceId: string): Promise<string | null | undefined>
  /** Throws when the workspace does not exist; bound from the owning service. */
  requireWorkspace(workspaceId: string): Promise<unknown>
  /** The normal task-creation path, reused verbatim so placement + task-type validation applies. */
  addTask(
    workspaceId: string,
    containerId: string,
    input: AddTaskInput,
    editor: BlockEditAuthority,
    createdBy: string | null,
  ): Promise<Block>
}

export class PublicBoardReads {
  constructor(private readonly deps: PublicBoardReadsDeps) {}

  /** The workspace's board services (visible service frames). */
  async listServices(workspaceId: string): Promise<Block[]> {
    await this.deps.requireWorkspace(workspaceId)
    const blocks = await this.deps.blockRepository.listByWorkspace(workspaceId)
    return blocks.filter((b) => b.level === 'frame' && !b.internal && !b.archived)
  }

  /**
   * The repositories this workspace can back a service with, each paired with the service that
   * already backs it.
   *
   * The discovery read behind headless service creation: the create takes a provider repo id, and
   * before this nothing on the external surface served one, so the one act of board setup a
   * deployment could not perform without a browser was also the one it could not even DESCRIBE.
   *
   * Three reads, all batched, never per-repo: the projection list, the workspace's frames, and ONE
   * account-scoped service list. The pairing is then an in-memory index: a `getByRepo`
   * per repository would be the N+1 this codebase bans, and on a workspace with a hundred
   * repositories it is a hundred queries to render one picker.
   *
   * The service read is ACCOUNT-scoped rather than scoped to this board's frames, because that is
   * the population the CREATE dedupes against (`findAccountWholeRepoService`). Asking only about
   * this board's own frames answers "no service backs this repository" for one the create will
   * refuse, and the two have to agree: a discovery read whose whole job is to say what a caller
   * may ask for cannot be reading a narrower table than the endpoint that decides.
   *
   * An unwired VCS integration answers an EMPTY list rather than throwing: this is a discovery
   * read, and "you have connected no repositories" and "this deployment has no VCS integration" are
   * the same instruction to the caller, connect one before creating a repo-backed service. The
   * CREATE is where the distinction bites, and it refuses there with the reason.
   */
  async listRepoOptions(workspaceId: string): Promise<PublicRepoOption[]> {
    await this.deps.requireWorkspace(workspaceId)
    if (!this.deps.repoProjectionRepository) return []
    const repos = await this.deps.repoProjectionRepository.list(workspaceId)
    if (repos.length === 0) return []
    const use = await this.repoUse(workspaceId)
    return repos.map((repo) => ({ repo, ...use(repo.githubId) }))
  }

  /**
   * The same judgement, for repositories this workspace has NOT linked.
   *
   * Its own entry point rather than a second derivation, because the two reads that answer "may I
   * back a service with this repository" must agree: `GET /api/v1/repos` asks it of the linked
   * projection, and the adoption discovery read (`GET /api/v1/repos/available`) asks it of what the
   * connection can reach, which is a superset. A repository already backing a service elsewhere in
   * the account is refused by the create either way, so a discovery read that could not say so would
   * hand a caller a repository whose very next call fails.
   *
   * Takes the ids rather than the rows: the repositories in question have no projection row here
   * yet, so their id is the only thing this workspace and the account's services share. An empty
   * input asks nothing and costs nothing.
   */
  async describeRepoUse(workspaceId: string, repoIds: readonly number[]): Promise<RepoUseByRepoId> {
    await this.deps.requireWorkspace(workspaceId)
    if (repoIds.length === 0) return new Map()
    const use = await this.repoUse(workspaceId)
    return new Map(repoIds.map((repoId) => [repoId, use(repoId)]))
  }

  /**
   * Build the "is this repository spoken for" verdict once, then answer it per id.
   *
   * Two batched reads (this board's frames, and ONE account-scoped service list), never a
   * `getByRepo` per repository: that is the N+1 this codebase bans, and on a workspace with a
   * hundred repositories it is a hundred queries to render one picker.
   *
   * The service read is ACCOUNT-scoped rather than scoped to this board's frames, because that is
   * the population the CREATE dedupes against (`findAccountWholeRepoService`). Asking only about
   * this board's own frames answers "no service backs this repository" for one the create will
   * refuse, and the two have to agree: a discovery read whose whole job is to say what a caller
   * may ask for cannot be reading a narrower table than the endpoint that decides.
   */
  private async repoUse(workspaceId: string): Promise<(repoId: number) => RepoUse> {
    const frames = (await this.deps.blockRepository.listByWorkspace(workspaceId)).filter(
      (block) => block.level === 'frame' && !block.internal && !block.archived,
    )
    const services = this.deps.serviceRepository
      ? await this.deps.serviceRepository.listByAccount(
          (await this.deps.accountOf(workspaceId)) ?? null,
        )
      : []
    // Whole-repo services only (no `directory`), which is exactly what `serviceBlockId` claims.
    const byRepo = new Map(
      services
        .filter((service) => service.repoGithubId != null && !service.directory)
        .map((service) => [service.repoGithubId as number, service.frameBlockId]),
    )
    const visibleFrames = new Set(frames.map((frame) => frame.id))
    return (repoId) => {
      const frameBlockId = byRepo.get(repoId)
      // A service homed on another board (one this board merely mounts, or does not mount at all)
      // is not a frame of THIS workspace, so its id is withheld: it would name a block this key
      // cannot read. `linkedElsewhere` is what stops that withholding reading as "available".
      const homedHere = frameBlockId !== undefined && visibleFrames.has(frameBlockId)
      return {
        serviceBlockId: homedHere ? frameBlockId : null,
        linkedElsewhere: frameBlockId !== undefined && !homedHere,
      }
    }
  }

  /**
   * Refuse a container that cannot hold a new task: missing / not the workspace's / a headless
   * `internal` anchor / not a frame / archived.
   *
   * Separate from {@link addServiceTask} so a caller doing PREPARATORY work for the create can
   * apply the same rule first, without duplicating it or having to create the task to find out.
   * `POST /api/v1/services/:serviceId/tasks` with a `ticket` is the case: it resolves the tracker
   * issue before the block exists, and resolving one is an outbound call to the workspace's
   * tracker, so a bad `serviceId` would otherwise cost a live third-party fetch and be answered
   * by the 404 it could have had first.
   */
  async assertTaskContainer(workspaceId: string, serviceId: string): Promise<Block> {
    await this.deps.requireWorkspace(workspaceId)
    const frame = await this.deps.blockRepository.get(workspaceId, serviceId)
    if (!frame || frame.internal) throw new NotFoundError('service', serviceId)
    if (frame.level !== 'frame') {
      throw new ValidationError('Tasks can only be created under a service')
    }
    if (frame.archived) throw new ValidationError('Cannot add a task to an archived service')
    return frame
  }

  /**
   * Create a task under a visible SERVICE FRAME the workspace owns. Rejects a missing / non-frame
   * / internal / archived container, then delegates to the normal `addTask` (which reuses all the
   * placement + task-type validation). Headless / no initiator.
   *
   * `editor` is supplied by the caller rather than fixed here even though every caller today is
   * the headless `/api/v1` surface: `input` is a full {@link AddTaskInput}, so it can carry a
   * merge preset the moment the public contract exposes one, and an exemption written INSIDE a
   * collaborator is one no route states and no coverage spec can see.
   */
  async addServiceTask(
    workspaceId: string,
    serviceId: string,
    input: AddTaskInput,
    editor: BlockEditAuthority,
  ): Promise<Block> {
    await this.assertTaskContainer(workspaceId, serviceId)
    return this.deps.addTask(workspaceId, serviceId, input, editor, null)
  }

  /**
   * ONE visible service frame the workspace owns, or null when the id names no such thing (absent,
   * another workspace's, a headless `internal` anchor, a non-frame block, or archived).
   *
   * The point read behind every per-service endpoint that is not a task list: a caller naming a
   * service has to be refused on exactly the population {@link listServiceTasksPage} and
   * {@link listServices} report, or a `serviceId` this key can see in one place answers a 404 in
   * another. Its own method rather than a `listServices().find()` at the call site, because that
   * would read the whole board to answer a keyed question.
   */
  async getService(workspaceId: string, serviceId: string): Promise<Block | null> {
    await this.deps.requireWorkspace(workspaceId)
    const frame = await this.deps.blockRepository.get(workspaceId, serviceId)
    if (!frame || frame.level !== 'frame' || frame.internal || frame.archived) return null
    return frame
  }

  /**
   * Fetch a board task + its enclosing service frame, scoped to the workspace. Returns null when
   * no such task exists in the workspace, it is not a `task`-level block, it is a headless
   * `internal` anchor, or it has no resolvable enclosing service frame — so the caller (and any
   * external key) sees only real, board-visible tasks it owns. The frame is returned in full (not
   * just its id) so a caller can gate on service state (e.g. refuse to START a task under an
   * archived service, while still allowing its status to be READ).
   */
  async getServiceTask(
    workspaceId: string,
    taskId: string,
  ): Promise<{ block: Block; service: Block } | null> {
    await this.deps.requireWorkspace(workspaceId)
    const blocks = await this.deps.blockRepository.listByWorkspace(workspaceId)
    const block = blocks.find((b) => b.id === taskId)
    if (!block || block.level !== 'task' || block.internal) return null
    const frame = serviceOf(blocks, block)
    if (!frame) return null
    return { block, service: frame }
  }

  /**
   * List ONE BOUNDED PAGE of a visible service's tasks — the whole subtree (tasks directly under
   * the frame AND under its modules), excluding headless `internal` anchors, optionally filtered
   * to one status. Returns null when the frame does not exist in the workspace or is not a visible
   * service frame (a non-frame / internal / archived block), so the caller 404s.
   *
   * Reads are SQL-bounded rather than "load the whole board and filter in JS": one point-read for
   * the frame, then ONE paged subtree query. That is exhaustive because a `task` may only be
   * parented by a `frame` or a `module` (enforced by `canReparent` on reparent and by
   * `BoardService.addTask` on create) — there is no deeper level to recurse through, so the
   * general `descendantIds` walk (which needs every block in memory) is unnecessary here.
   *
   * `afterId` is the exclusive keyset cursor and ordering is by block id: blocks carry no creation
   * timestamp, so id order is arbitrary but STABLE, which is what a cursor needs. One extra row
   * beyond `limit` is read so "is there another page" costs no second query.
   */
  async listServiceTasksPage(
    workspaceId: string,
    serviceId: string,
    opts: { limit: number; afterId?: string; status?: BlockStatus },
  ): Promise<{ tasks: Block[]; hasMore: boolean } | null> {
    if (!(await this.getService(workspaceId, serviceId))) return null
    const rows = await this.deps.blockRepository.listServiceTasks(workspaceId, serviceId, {
      ...opts,
      limit: opts.limit + 1,
    })
    const hasMore = rows.length > opts.limit
    return { tasks: hasMore ? rows.slice(0, opts.limit) : rows, hasMore }
  }
}
