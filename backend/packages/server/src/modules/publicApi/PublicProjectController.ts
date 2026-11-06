import {
  type Block,
  type DescriptorFieldValues,
  createPublicProjectContract,
  createPublicProjectTaskContract,
  foldFindings,
  getPublicFindingsRevisionContract,
  getPublicProjectContract,
  getPublicProjectFindingsContract,
  getPublicProjectTaskContract,
  getPublicResearchDefinitionContract,
  isAdhocQuestionId,
  linkPublicProjectServicesContract,
  listPublicProjectsContract,
  listPublicProjectTasksContract,
  listPublicResearchDefinitionsContract,
  mountPublicProjectContract,
  type PublicProject,
  type PublicProjectTask,
  publishPublicResearchDefinitionContract,
  researchCoverage,
  type ResearchProject,
  retryPublicProjectTaskContract,
  startPublicProjectTaskContract,
  stopPublicProjectTaskContract,
  UNATTRIBUTED_BLOCK_EDIT_AUTHORITY,
  unlinkPublicProjectServicesContract,
} from '@cat-factory/contracts'
import type { PublicApiKeyAuth } from '@cat-factory/integrations'
import { ConflictError, NotFoundError, ValidationError } from '@cat-factory/kernel'
import type { MountedProject, ProjectsModule } from '@cat-factory/orchestration'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { requireCapability } from '../../http/guards.js'
import { authorize, refuse } from './publicApiAuth.js'
import { resolveTaskTypeFields } from './taskTypeFields.js'
import { retryTaskRun, startTaskRun, stopTaskRun } from './taskRunActions.js'

// The public PROJECTS surface: projects a key's workspace mounts, their service links and tasks,
// and a research project's findings. A project is account-owned and mounted on boards like a
// service, so every read here takes the projects the KEY's workspace mounts. Its tasks are created
// and run on the board that homes it, which is the board whose runs and spend they belong to; a
// key whose board only mounts the project reads them and is refused a write with
// `project_homed_elsewhere`.

function requireProjects<E extends AppEnv>(c: Context<E>): ProjectsModule {
  return requireCapability(c.get('container').projects, 'Projects are not configured')
}

async function accountOf<E extends AppEnv>(c: Context<E>, workspaceId: string): Promise<string> {
  return (await c.get('container').workspaceService.accountOf(workspaceId)) ?? ''
}

/**
 * The project as the key sees it. Its links are named by service FRAME block id, the id
 * `/api/v1/services` serves, so a caller can link what it lists.
 */
function toPublicProject(
  mounted: MountedProject,
  keyWorkspaceId: string,
  pin: ResearchProject | undefined,
  frames: ReadonlyMap<string, string>,
): PublicProject {
  const { project, rootBlock } = mounted
  return {
    projectId: project.id,
    kind: project.kind,
    title: rootBlock.title,
    description: rootBlock.description,
    serviceIds: project.serviceIds.flatMap((id) => {
      const frame = frames.get(id)
      return frame ? [frame] : []
    }),
    homedHere: mounted.homeWorkspaceId === keyWorkspaceId,
    research: pin
      ? {
          definitionKey: pin.definitionKey,
          definitionVersion: pin.definitionVersion,
          definitionHash: pin.definitionHash,
          inputs: pin.inputs as DescriptorFieldValues,
        }
      : null,
    createdAt: project.createdAt,
  }
}

function toPublicProjectTask(block: Block, projectId: string): PublicProjectTask {
  return {
    taskId: block.id,
    projectId,
    title: block.title,
    description: block.description,
    taskType: block.taskType ?? 'feature',
    status: block.status,
    progress: block.progress,
    runId: block.executionId,
  }
}

/** The project with its research pin, projected for the key. */
async function projectFor<E extends AppEnv>(
  c: Context<E>,
  workspaceId: string,
  mounted: MountedProject,
): Promise<PublicProject> {
  const projects = requireProjects(c)
  const pin = await projects.research.projects.get(mounted.project.id)
  const frames = await projects.service.frameIdsByService(mounted.project.serviceIds)
  return toPublicProject(mounted, workspaceId, pin ?? undefined, frames)
}

/** A project the key's board homes, for a task write. */
async function requireHomedProject<E extends AppEnv>(
  c: Context<E>,
  workspaceId: string,
  projectId: string,
): Promise<MountedProject> {
  const mounted = await requireProjects(c).service.getMounted(workspaceId, projectId)
  if (mounted.homeWorkspaceId !== workspaceId) {
    throw new ConflictError(
      "A project's tasks are created and run on the board that homes it",
      'project_homed_elsewhere',
      { projectId },
    )
  }
  return mounted
}

/** One task under the project, read at its home. */
async function requireProjectTask<E extends AppEnv>(
  c: Context<E>,
  mounted: MountedProject,
  taskId: string,
): Promise<Block> {
  const tasks = await requireProjects(c).service.listTasks(mounted.project)
  const task = tasks.find((t) => t.id === taskId)
  if (!task) throw new NotFoundError('Task', taskId)
  return task
}

async function reread<E extends AppEnv>(
  c: Context<E>,
  mounted: MountedProject,
  task: Block,
): Promise<PublicProjectTask> {
  const tasks = await requireProjects(c).service.listTasks(mounted.project)
  return toPublicProjectTask(tasks.find((t) => t.id === task.id) ?? task, mounted.project.id)
}

export function publicProjectController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  registerDefinitionRoutes(app)
  registerProjectRoutes(app)
  registerProjectTaskRoutes(app)
  registerFindingsRoutes(app)
  return app
}

function registerDefinitionRoutes(app: Hono<AppEnv>): void {
  buildHonoRoute(app, listPublicResearchDefinitionsContract, async (c) => {
    const gate = await authorize(c, listPublicResearchDefinitionsContract.minScope)
    if ('fail' in gate) return refuse(c, gate.fail)
    const account = await accountOf(c, gate.auth.workspaceId)
    const definitions = await c.get('container').researchDefinitions.list(account)
    return c.json({ definitions }, 200)
  })

  buildHonoRoute(app, getPublicResearchDefinitionContract, async (c) => {
    const gate = await authorize(c, getPublicResearchDefinitionContract.minScope)
    if ('fail' in gate) return refuse(c, gate.fail)
    const { key } = c.req.valid('param')
    const account = await accountOf(c, gate.auth.workspaceId)
    const definitions = (await c.get('container').researchDefinitions.list(account)).filter(
      (d) => d.definition.key === key,
    )
    if (definitions.length === 0) {
      throw new NotFoundError('ResearchDefinition', key, {
        reason: 'research_definition_not_found',
      })
    }
    return c.json({ definitions }, 200)
  })

  buildHonoRoute(app, publishPublicResearchDefinitionContract, async (c) => {
    const gate = await authorize(c, publishPublicResearchDefinitionContract.minScope)
    if ('fail' in gate) return refuse(c, gate.fail)
    const publisher = requireCapability(
      requireProjects(c).research.publisher,
      'Publishing research definitions is not configured',
    )
    const { key, version } = c.req.valid('param')
    const stored = await publisher.publish(await accountOf(c, gate.auth.workspaceId), {
      ...c.req.valid('json'),
      key,
      version: Number(version),
    })
    return c.json(
      { origin: 'stored' as const, contentHash: stored.contentHash, definition: stored.definition },
      201,
    )
  })
}

function registerProjectRoutes(app: Hono<AppEnv>): void {
  buildHonoRoute(app, listPublicProjectsContract, async (c) => {
    const gate = await authorize(c, listPublicProjectsContract.minScope)
    if ('fail' in gate) return refuse(c, gate.fail)
    const projects = requireProjects(c)
    const mounted = await projects.service.listMounted(gate.auth.workspaceId)
    const pins = new Map(
      (await projects.research.projects.listByProjectIds(mounted.map((m) => m.project.id))).map(
        (pin) => [pin.projectId, pin],
      ),
    )
    const frames = await projects.service.frameIdsByService(
      mounted.flatMap((m) => m.project.serviceIds),
    )
    return c.json(
      {
        projects: mounted.map((m) =>
          toPublicProject(m, gate.auth.workspaceId, pins.get(m.project.id), frames),
        ),
      },
      200,
    )
  })

  buildHonoRoute(app, createPublicProjectContract, async (c) => {
    const gate = await authorize(c, createPublicProjectContract.minScope)
    if ('fail' in gate) return refuse(c, gate.fail)
    const workspaceId = gate.auth.workspaceId
    const { serviceIds, research, ...body } = c.req.valid('json')
    const projects = requireProjects(c)
    const created = await projects.service.create(workspaceId, {
      ...body,
      serviceIds: await projects.service.serviceIdsOfFrames(workspaceId, serviceIds ?? []),
      ...(research ? { research: { ...research, inputs: research.inputs ?? {} } } : {}),
    })
    const mounted = { ...created, homeWorkspaceId: workspaceId }
    return c.json(await projectFor(c, workspaceId, mounted), 201)
  })

  buildHonoRoute(app, getPublicProjectContract, async (c) => {
    const gate = await authorize(c, getPublicProjectContract.minScope)
    if ('fail' in gate) return refuse(c, gate.fail)
    const { workspaceId } = gate.auth
    const mounted = await requireProjects(c).service.getMounted(
      workspaceId,
      c.req.valid('param').projectId,
    )
    return c.json(await projectFor(c, workspaceId, mounted), 200)
  })

  buildHonoRoute(app, linkPublicProjectServicesContract, async (c) => {
    const gate = await authorize(c, linkPublicProjectServicesContract.minScope)
    if ('fail' in gate) return refuse(c, gate.fail)
    const added = await requireProjects(c).service.serviceIdsOfFrames(
      gate.auth.workspaceId,
      c.req.valid('json').serviceIds,
    )
    const linked = await relink(c, gate.auth, c.req.valid('param').projectId, (current) => [
      ...new Set([...current, ...added]),
    ])
    return c.json(linked, 200)
  })

  buildHonoRoute(app, unlinkPublicProjectServicesContract, async (c) => {
    const gate = await authorize(c, unlinkPublicProjectServicesContract.minScope)
    if ('fail' in gate) return refuse(c, gate.fail)
    const dropped = new Set(
      await requireProjects(c).service.serviceIdsOfFrames(
        gate.auth.workspaceId,
        c.req.valid('json').serviceIds,
      ),
    )
    const unlinked = await relink(c, gate.auth, c.req.valid('param').projectId, (current) =>
      current.filter((id) => !dropped.has(id)),
    )
    return c.json(unlinked, 200)
  })

  buildHonoRoute(app, mountPublicProjectContract, async (c) => {
    const gate = await authorize(c, mountPublicProjectContract.minScope)
    if ('fail' in gate) return refuse(c, gate.fail)
    const { workspaceId } = gate.auth
    const { projectId } = c.req.valid('param')
    const projects = requireProjects(c)
    await projects.service.mount(workspaceId, projectId)
    const mounted = await projects.service.getMounted(workspaceId, projectId)
    return c.json(await projectFor(c, workspaceId, mounted), 200)
  })
}

/** Replace a project's links with `next(current)`, and answer with the project. */
async function relink<E extends AppEnv>(
  c: Context<E>,
  auth: PublicApiKeyAuth,
  projectId: string,
  next: (current: string[]) => string[],
): Promise<PublicProject> {
  const projects = requireProjects(c)
  const mounted = await projects.service.getMounted(auth.workspaceId, projectId)
  const project = await projects.service.setServices(
    auth.workspaceId,
    projectId,
    next(mounted.project.serviceIds),
  )
  return projectFor(c, auth.workspaceId, { ...mounted, project })
}

function registerProjectTaskRoutes(app: Hono<AppEnv>): void {
  buildHonoRoute(app, listPublicProjectTasksContract, async (c) => {
    const gate = await authorize(c, listPublicProjectTasksContract.minScope)
    if ('fail' in gate) return refuse(c, gate.fail)
    const projects = requireProjects(c)
    const mounted = await projects.service.getMounted(
      gate.auth.workspaceId,
      c.req.valid('param').projectId,
    )
    const tasks = await projects.service.listTasks(mounted.project)
    return c.json({ tasks: tasks.map((t) => toPublicProjectTask(t, mounted.project.id)) }, 200)
  })

  buildHonoRoute(app, createPublicProjectTaskContract, async (c) => {
    const gate = await authorize(c, createPublicProjectTaskContract.minScope)
    if ('fail' in gate) return refuse(c, gate.fail)
    const container = c.get('container')
    const { workspaceId } = gate.auth
    const mounted = await requireHomedProject(c, workspaceId, c.req.valid('param').projectId)
    const body = c.req.valid('json')
    const kind = await container.projectKinds.get(mounted.project.kind)
    const taskType = body.taskType ?? kind?.taskTypes[0]?.taskType
    if (!taskType) {
      throw new ValidationError(`Project kind '${mounted.project.kind}' is not registered`, {
        reason: 'project_kind_unregistered',
        kind: mounted.project.kind,
      })
    }
    const taskTypeFields = resolveTaskTypeFields(
      { title: body.title, taskType, fields: body.fields },
      container.taskTypeRegistry,
    )
    const block = await container.boardService.addTask(
      workspaceId,
      mounted.project.rootBlockId,
      {
        title: body.title,
        ...(body.description === undefined ? {} : { description: body.description }),
        taskType,
        ...(taskTypeFields ? { taskTypeFields } : {}),
      },
      UNATTRIBUTED_BLOCK_EDIT_AUTHORITY,
    )
    return c.json(toPublicProjectTask(block, mounted.project.id), 201)
  })

  buildHonoRoute(app, getPublicProjectTaskContract, async (c) => {
    const gate = await authorize(c, getPublicProjectTaskContract.minScope)
    if ('fail' in gate) return refuse(c, gate.fail)
    const { projectId, taskId } = c.req.valid('param')
    const mounted = await requireProjects(c).service.getMounted(gate.auth.workspaceId, projectId)
    const task = await requireProjectTask(c, mounted, taskId)
    return c.json(toPublicProjectTask(task, projectId), 200)
  })

  buildHonoRoute(app, startPublicProjectTaskContract, async (c) => {
    const gate = await authorize(c, startPublicProjectTaskContract.minScope)
    if ('fail' in gate) return refuse(c, gate.fail)
    const { projectId, taskId } = c.req.valid('param')
    const mounted = await requireHomedProject(c, gate.auth.workspaceId, projectId)
    const task = await requireProjectTask(c, mounted, taskId)
    const refused = await startTaskRun(c, gate.auth, task, c.req.valid('json').pipelineId)
    if (refused) return c.json(refused.body, refused.status)
    return c.json(await reread(c, mounted, task), 202)
  })

  buildHonoRoute(app, stopPublicProjectTaskContract, async (c) => {
    const gate = await authorize(c, stopPublicProjectTaskContract.minScope)
    if ('fail' in gate) return refuse(c, gate.fail)
    const { projectId, taskId } = c.req.valid('param')
    const mounted = await requireHomedProject(c, gate.auth.workspaceId, projectId)
    const task = await requireProjectTask(c, mounted, taskId)
    const refused = await stopTaskRun(c, gate.auth, task.id)
    if (refused) return c.json(refused.body, refused.status)
    return c.json(await reread(c, mounted, task), 200)
  })

  buildHonoRoute(app, retryPublicProjectTaskContract, async (c) => {
    const gate = await authorize(c, retryPublicProjectTaskContract.minScope)
    if ('fail' in gate) return refuse(c, gate.fail)
    const { projectId, taskId } = c.req.valid('param')
    const mounted = await requireHomedProject(c, gate.auth.workspaceId, projectId)
    const task = await requireProjectTask(c, mounted, taskId)
    const refused = await retryTaskRun(c, gate.auth, task)
    if (refused) return c.json(refused.body, refused.status)
    return c.json(await reread(c, mounted, task), 202)
  })
}

function registerFindingsRoutes(app: Hono<AppEnv>): void {
  buildHonoRoute(app, getPublicProjectFindingsContract, async (c) => {
    const gate = await authorize(c, getPublicProjectFindingsContract.minScope)
    if ('fail' in gate) return refuse(c, gate.fail)
    const { projectId } = c.req.valid('param')
    const { workspaceId } = gate.auth
    const projects = requireProjects(c)
    const mounted = await projects.service.getMounted(workspaceId, projectId)
    const pin = await requirePin(projects, projectId)
    const findings = requireFindings(projects)
    const definition = await c
      .get('container')
      .researchDefinitions.get(
        await accountOf(c, workspaceId),
        pin.definitionKey,
        pin.definitionVersion,
      )
    const revisions = await findings.listRevisions(mounted.project)
    const folded = foldFindings(revisions)
    const adhocIds = [
      ...new Set(Object.keys(folded.byQuestion).filter((id) => isAdhocQuestionId(id))),
    ]
    return c.json(
      {
        projectId,
        definitionKey: pin.definitionKey,
        definitionVersion: pin.definitionVersion,
        summary: folded.summary,
        latestRevisionId: folded.latestRevisionId,
        findings: Object.values(folded.byQuestion),
        learnings: folded.learnings,
        coverage: researchCoverage(definition?.definition.topics ?? [], adhocIds, folded),
        revisions: revisions.map(({ body: _body, ...meta }) => meta),
      },
      200,
    )
  })

  buildHonoRoute(app, getPublicFindingsRevisionContract, async (c) => {
    const gate = await authorize(c, getPublicFindingsRevisionContract.minScope)
    if ('fail' in gate) return refuse(c, gate.fail)
    const { projectId, revisionId } = c.req.valid('param')
    const projects = requireProjects(c)
    const mounted = await projects.service.getMounted(gate.auth.workspaceId, projectId)
    const revision = await requireFindings(projects).getRevision(mounted.project, revisionId)
    if (!revision) throw new NotFoundError('FindingsRevision', revisionId)
    const { body, ...meta } = revision
    return c.json(
      { ...meta, summary: body.summary, findings: body.findings, learnings: body.learnings },
      200,
    )
  })
}

async function requirePin(projects: ProjectsModule, projectId: string): Promise<ResearchProject> {
  const pin = await projects.research.projects.get(projectId)
  if (!pin) {
    throw new ValidationError('This project pins no research definition', {
      reason: 'research_project_not_pinned',
      projectId,
    })
  }
  return pin
}

function requireFindings(projects: ProjectsModule) {
  return requireCapability(projects.research.findings, 'Research findings are not configured')
}
