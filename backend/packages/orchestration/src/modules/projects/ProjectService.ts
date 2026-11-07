import {
  type CreateProjectInput,
  type MountServiceInput,
  type Project,
  type ProjectKindDescriptor,
  type ResearchPinInput,
  type ResearchProject,
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
  type ResearchDefinitionSource,
  type ResearchProjectRepository,
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
  /** What a kind keeping `research` data pins at creation, and where. */
  research: { definitions: ResearchDefinitionSource; projects: ResearchProjectRepository }
  idGenerator: IdGenerator
  clock: Clock
  events?: ExecutionEventPublisher
  logger?: Logger
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
    const researchPin = await this.resolveResearchPin(accountId, kind, input.research, projectId)
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
      if (researchPin) await this.deps.research.projects.insert(researchPin)
      await this.deps.blockRepository.insert(workspaceId, rootBlock, project.id)
      await this.deps.workspaceMountRepository.upsert(mount)
    } catch (error) {
      await this.undoCreate(workspaceId, project)
      throw error
    }
    await this.emitAdded(workspaceId, rootBlock.id)
    return { project, rootBlock: applyMountLayout(rootBlock, mount), mount }
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
   * The research definition a kind keeping `research` data pins, resolved and checked before any
   * row is written. A kind keeping none refuses a pin rather than dropping it.
   */
  private async resolveResearchPin(
    accountId: string | null,
    kind: ProjectKindDescriptor,
    pin: ResearchPinInput | undefined,
    projectId: string,
  ): Promise<ResearchProject | null> {
    if (kind.data !== 'research') {
      if (!pin) return null
      throw new ValidationError(`A '${kind.id}' project keeps no research definition`, {
        reason: 'research_pin_not_accepted',
        kind: kind.id,
      })
    }
    if (!pin) {
      throw new ValidationError('A research project needs a research definition to pin', {
        reason: 'research_pin_required',
        kind: kind.id,
      })
    }
    const account = accountId ?? ''
    const resolved =
      pin.definitionVersion === undefined
        ? await this.deps.research.definitions.latest(account, pin.definitionKey)
        : await this.deps.research.definitions.get(
            account,
            pin.definitionKey,
            pin.definitionVersion,
          )
    if (!resolved) {
      throw new ValidationError('No research definition matches that key and version', {
        reason: 'research_definition_not_found',
        definitionKey: pin.definitionKey,
        definitionVersion: pin.definitionVersion ?? null,
      })
    }
    // Defaults first, then validate, then pin only the visible answers: the bag every other
    // descriptor-form door freezes, so a hidden field can never pin an unvalidated value.
    const fields = resolved.definition.inputs
    const inputs = withDescriptorFieldDefaults(fields, pin.inputs)
    const problems = validateDescriptorFields(fields, inputs)
    if (problems.length) {
      throw new ValidationError('The research inputs do not satisfy the definition', {
        reason: 'research_inputs_invalid',
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
    const found = await this.deps.serviceRepository.listByIds([...serviceIds])
    const linkable = new Set(
      found.filter((s) => (s.accountId ?? null) === accountId).map((s) => s.id),
    )
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
        await this.deps.research.projects.deleteMany([project.id])
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
