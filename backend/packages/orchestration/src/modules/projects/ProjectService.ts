import {
  type CreateProjectInput,
  type MountServiceInput,
  type Project,
  type ProjectKindDescriptor,
  type ProjectPin,
  type ProjectPinInput,
  type UpdateMountInput,
  sanitizeDescriptorFields,
  validateDescriptorFields,
  withDescriptorFieldDefaults,
} from '@cat-factory/contracts'
import {
  type Block,
  type BlockRepository,
  type Clock,
  type ExecutionEventPublisher,
  type IdGenerator,
  type Logger,
  type ProjectKindSource,
  type ProjectRepository,
  type ProjectDefinitionSource,
  type ProjectRecordRepository,
  type ServiceRepository,
  type WorkspaceMount,
  type WorkspaceMountRepository,
  type WorkspaceRepository,
  ValidationError,
  applyMountLayout,
  assertFound,
  noopLogger,
  requireWorkspace,
  runBestEffort,
} from '@cat-factory/kernel'

export interface ProjectServiceDependencies {
  projectRepository: ProjectRepository
  serviceRepository: ServiceRepository
  workspaceMountRepository: WorkspaceMountRepository
  workspaceRepository: WorkspaceRepository
  blockRepository: BlockRepository
  projectKinds: ProjectKindSource
  /** Where a kind that pins a definition resolves it, and where the pin is kept. */
  definitions: ProjectDefinitionSource
  records: ProjectRecordRepository
  idGenerator: IdGenerator
  clock: Clock
  events?: ExecutionEventPublisher
  logger?: Logger
}

/** A project a board mounts, with its root block and the board that homes it. */
export interface MountedProject {
  project: Project
  rootBlock: Block
  homeWorkspaceId: string
}

export interface CreatedProject {
  project: Project
  rootBlock: Block
  mount: WorkspaceMount
}

/**
 * Account-owned projects: create one (its root block, the project row and the creating board's
 * mount), set its service links, list the account's catalog, and mount, unmount or re-lay it out
 * on a board. A project is shared within its account only, exactly as a service is.
 */
export class ProjectService {
  private readonly log: Logger

  constructor(private readonly deps: ProjectServiceDependencies) {
    this.log = deps.logger ?? noopLogger
  }

  /** The account's projects, each with how many boards mount it (one grouped count). */
  async listForAccount(accountId: string | null): Promise<Project[]> {
    const projects = await this.deps.projectRepository.listByAccount(accountId)
    const counts = await this.deps.workspaceMountRepository.countBySubjectIds(
      projects.map((p) => p.id),
    )
    return projects.map((project) => ({ ...project, mountCount: counts[project.id] ?? 0 }))
  }

  async create(workspaceId: string, input: CreateProjectInput): Promise<CreatedProject> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    const accountId = (await this.deps.workspaceRepository.accountOf(workspaceId)) ?? null
    const kind = await this.deps.projectKinds.get(input.kind)
    if (!kind) {
      throw new ValidationError(`Project kind '${input.kind}' is not registered`, {
        reason: 'project_kind_unregistered',
        kind: input.kind,
      })
    }
    await this.assertLinkableServices(accountId, input.serviceIds)
    const projectId = this.deps.idGenerator.next('prj')
    const pin = await this.resolvePin(accountId, kind, input.definition, projectId)
    const now = this.deps.clock.now()
    const position =
      input.position ??
      this.defaultPosition(await this.deps.workspaceMountRepository.listByWorkspace(workspaceId))
    const project: Project = {
      id: projectId,
      accountId,
      kind: kind.id,
      rootBlockId: this.deps.idGenerator.next('blk'),
      serviceIds: input.serviceIds,
      createdAt: now,
    }
    const rootBlock: Block = {
      id: project.rootBlockId,
      title: input.title,
      type: 'project',
      description: input.description ?? '',
      position,
      status: 'planned',
      progress: 0,
      dependsOn: [],
      executionId: null,
      level: 'project',
      parentId: null,
    }
    const mount: WorkspaceMount = {
      workspaceId,
      subjectKind: 'project',
      subjectId: project.id,
      position,
      size: null,
      createdAt: now,
    }
    // The row goes first: the root block's owner stamp and the mount both name the project, and
    // the persistence RPC scopes each of them through it.
    await this.deps.projectRepository.insert(project)
    try {
      if (pin) await this.deps.records.insertPin(pin)
      await this.deps.blockRepository.insert(workspaceId, rootBlock, project.id)
      await this.deps.workspaceMountRepository.upsert(mount)
    } catch (error) {
      await this.undoCreate(workspaceId, project)
      throw error
    }
    await this.emitAdded(workspaceId, rootBlock.id)
    return { project, rootBlock: applyMountLayout(rootBlock, mount), mount }
  }

  /** Every project the board mounts, with its root block and home, in batched reads. */
  async listMounted(workspaceId: string): Promise<MountedProject[]> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    const mounts = await this.deps.workspaceMountRepository.listByWorkspace(workspaceId)
    const ids = mounts.filter((m) => m.subjectKind === 'project').map((m) => m.subjectId)
    if (ids.length === 0) return []
    const projects = await this.deps.projectRepository.listByIds(ids)
    const roots = new Map(
      (await this.deps.blockRepository.findByIds(projects.map((p) => p.rootBlockId))).map((r) => [
        r.block.id,
        r,
      ]),
    )
    return projects.flatMap((project) => {
      const root = roots.get(project.rootBlockId)
      return root ? [{ project, rootBlock: root.block, homeWorkspaceId: root.workspaceId }] : []
    })
  }

  /** One project the board mounts, with its root block and home. 404s otherwise. */
  async getMounted(workspaceId: string, projectId: string): Promise<MountedProject> {
    const project = await this.requireMountedProject(workspaceId, projectId)
    const root = assertFound(
      await this.deps.blockRepository.findById(project.rootBlockId),
      'Project',
      projectId,
    )
    return { project, rootBlock: root.block, homeWorkspaceId: root.workspaceId }
  }

  /**
   * The service ids of the given service FRAME block ids, among the services the board mounts.
   * The public API names a service by its frame block, a project's links by the service. Frame ids
   * are only unique per board, so the lookup is the board's own. A frame naming no service the
   * board mounts is kept as given, so the link refuses it the way it refuses any unknown id.
   */
  async serviceIdsOfFrames(workspaceId: string, frameBlockIds: string[]): Promise<string[]> {
    if (frameBlockIds.length === 0) return []
    const mounts = await this.deps.workspaceMountRepository.listByWorkspace(workspaceId)
    const mounted = mounts.filter((m) => m.subjectKind === 'service').map((m) => m.subjectId)
    const services = await this.deps.serviceRepository.listByIds(mounted)
    const byFrame = new Map(services.map((s) => [s.frameBlockId, s.id]))
    return frameBlockIds.map((frame) => byFrame.get(frame) ?? frame)
  }

  /** The frame block id of each of the given services, in one query; the inverse of the above. */
  async frameIdsByService(serviceIds: string[]): Promise<Map<string, string>> {
    if (serviceIds.length === 0) return new Map()
    const services = await this.deps.serviceRepository.listByIds([...new Set(serviceIds)])
    return new Map(services.map((s) => [s.id, s.frameBlockId]))
  }

  /** The board-visible tasks under a project, read at its home in one query. */
  async listTasks(project: Project): Promise<Block[]> {
    const owned = await this.deps.blockRepository.listByOwners([project.id])
    return owned.filter((b) => b.level === 'task' && !b.internal)
  }

  /** Replace a project's service links. The board must mount the project. */
  async setServices(
    workspaceId: string,
    projectId: string,
    serviceIds: string[],
  ): Promise<Project> {
    const project = await this.requireMountedProject(workspaceId, projectId)
    await this.assertLinkableServices(project.accountId, serviceIds)
    await this.deps.projectRepository.setServiceLinks(projectId, serviceIds)
    await this.emitUpdated(workspaceId, project.rootBlockId)
    return { ...project, serviceIds }
  }

  /** Mount an existing project of the board's own account. Idempotent. */
  async mount(
    workspaceId: string,
    projectId: string,
    input: MountServiceInput = {},
  ): Promise<WorkspaceMount> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    const project = assertFound(
      await this.deps.projectRepository.get(projectId),
      'Project',
      projectId,
    )
    const account = (await this.deps.workspaceRepository.accountOf(workspaceId)) ?? null
    if (account !== project.accountId) {
      throw new ValidationError('A project can only be mounted within its own organization')
    }
    const existing = await this.deps.workspaceMountRepository.get(workspaceId, projectId)
    if (existing) return existing
    const mounts = await this.deps.workspaceMountRepository.listByWorkspace(workspaceId)
    const mount: WorkspaceMount = {
      workspaceId,
      subjectKind: 'project',
      subjectId: projectId,
      position: input.position ?? this.defaultPosition(mounts),
      size: null,
      createdAt: this.deps.clock.now(),
    }
    await this.deps.workspaceMountRepository.upsert(mount)
    await this.emitUpdated(workspaceId, project.rootBlockId)
    return mount
  }

  /** Remove a project from a board. The project itself, homed elsewhere, is untouched. */
  async unmount(workspaceId: string, projectId: string): Promise<void> {
    const project = await this.requireMountedProject(workspaceId, projectId)
    const root = await this.deps.blockRepository.get(workspaceId, project.rootBlockId)
    if (root) {
      throw new ValidationError(
        'This board homes the project; delete the project instead of unmounting it',
      )
    }
    await this.deps.workspaceMountRepository.remove(workspaceId, projectId)
    await this.emitUpdated(workspaceId, project.rootBlockId)
  }

  async updateLayout(
    workspaceId: string,
    projectId: string,
    patch: UpdateMountInput,
  ): Promise<WorkspaceMount> {
    await this.requireMountedProject(workspaceId, projectId)
    await this.deps.workspaceMountRepository.update(workspaceId, projectId, patch)
    return assertFound(
      await this.deps.workspaceMountRepository.get(workspaceId, projectId),
      'WorkspaceMount',
      projectId,
    )
  }

  private async requireMountedProject(workspaceId: string, projectId: string): Promise<Project> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    const mount = await this.deps.workspaceMountRepository.get(workspaceId, projectId)
    const project =
      mount?.subjectKind === 'project' ? await this.deps.projectRepository.get(projectId) : null
    return assertFound(project, 'Project', projectId)
  }

  /**
   * The definition a kind that pins one resolves at creation, checked before any row is written.
   * A kind that pins none refuses a definition rather than dropping it.
   */
  private async resolvePin(
    accountId: string | null,
    kind: ProjectKindDescriptor,
    input: ProjectPinInput | undefined,
    projectId: string,
  ): Promise<ProjectPin | null> {
    if (!input) {
      if (kind.definition !== 'required') return null
      throw new ValidationError(`A '${kind.id}' project needs a definition to pin`, {
        reason: 'project_definition_required',
        kind: kind.id,
      })
    }
    if (!kind.definition) {
      throw new ValidationError(`A '${kind.id}' project pins no definition`, {
        reason: 'project_definition_not_accepted',
        kind: kind.id,
      })
    }
    const account = accountId ?? ''
    const resolved =
      input.version === undefined
        ? await this.deps.definitions.latest(account, kind.id, input.key)
        : await this.deps.definitions.get(account, kind.id, input.key, input.version)
    if (!resolved) {
      throw new ValidationError(`No '${kind.id}' definition matches that key and version`, {
        reason: 'project_definition_not_found',
        kind: kind.id,
        definitionKey: input.key,
        definitionVersion: input.version ?? null,
      })
    }
    // Defaults first, then validate, then pin only the visible answers: the bag every other
    // descriptor-form door freezes, so a hidden field can never pin an unvalidated value.
    const fields = resolved.definition.inputs
    const inputs = withDescriptorFieldDefaults(fields, input.inputs)
    const problems = validateDescriptorFields(fields, inputs)
    if (problems.length) {
      throw new ValidationError('The inputs do not satisfy the definition', {
        reason: 'project_definition_inputs_invalid',
        problems,
      })
    }
    return {
      projectId,
      definitionKey: resolved.definition.key,
      definitionVersion: resolved.definition.version,
      definitionHash: resolved.contentHash,
      inputs: sanitizeDescriptorFields(fields, inputs),
    }
  }

  /** Every linked service must exist and belong to the project's own account. */
  private async assertLinkableServices(
    accountId: string | null,
    serviceIds: readonly string[],
  ): Promise<void> {
    if (serviceIds.length === 0) return
    // Read the account's own services rather than the named ids: a mothership node's persistence
    // RPC refuses a by-id read naming a missing or foreign service as a whole, which would turn
    // this refusal into a 404 there and a 422 everywhere else.
    const owned = await this.deps.serviceRepository.listByAccount(accountId)
    const linkable = new Set(owned.map((s) => s.id))
    const invalid = serviceIds.filter((id) => !linkable.has(id))
    if (invalid.length) {
      throw new ValidationError('A project can only link services of its own organization', {
        reason: 'project_service_link_invalid',
        serviceIds: invalid,
      })
    }
  }

  /**
   * Remove whatever a failed create wrote. Nothing reclaims a project whose root never landed (the
   * removal cascade starts from a deleted root), so without this it would stay in the catalog.
   */
  private async undoCreate(workspaceId: string, project: Project): Promise<void> {
    const fields = { workspaceId, projectId: project.id }
    await runBestEffort(
      this.log,
      'project create rollback',
      async () => {
        await this.deps.workspaceMountRepository.remove(workspaceId, project.id)
        await this.deps.blockRepository.deleteMany(workspaceId, [project.rootBlockId])
        await this.deps.records.deleteByProjects([project.id])
        await this.deps.projectRepository.deleteMany([project.id])
      },
      fields,
    )
  }

  private defaultPosition(existing: readonly WorkspaceMount[]): { x: number; y: number } {
    const n = existing.length
    const columns = 5
    return { x: 80 + (n % columns) * 48, y: 80 + Math.floor(n / columns) * 48 }
  }

  private emitAdded(workspaceId: string, blockId: string): Promise<void> {
    return runBestEffort(this.log, 'project board event', () =>
      this.deps.events?.boardChanged(workspaceId, { reason: 'block-added', blockId }),
    )
  }

  private emitUpdated(workspaceId: string, blockId: string): Promise<void> {
    return runBestEffort(this.log, 'project board event', () =>
      this.deps.events?.boardChanged(workspaceId, { reason: 'block-updated', blockId }),
    )
  }
}
