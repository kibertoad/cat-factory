import {
  addPublicTaskDependencyContract,
  attachPublicTaskDocumentContract,
  createPublicServiceContract,
  detachPublicTaskDocumentContract,
  listPublicReposContract,
  listPublicTaskDocumentsContract,
  type CreatePublicServiceInput,
  type PublicAttachedDocument,
  removePublicTaskDependencyContract,
} from '@cat-factory/contracts'
import type { Block, PublicTask, SourceDocument } from '@cat-factory/contracts'
import { NotFoundError } from '@cat-factory/kernel'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv, ServerContainer } from '../../http/env.js'
import { requireCapability } from '../../http/guards.js'
import { toPublicRepo, toPublicService, toPublicTask } from './boardProjection.js'
import { resolveDocuments } from './documentAttachment.js'
import { authorizeOrThrow } from './publicApiAuth.js'

// Board PROVISIONING (`GET /api/v1/repos`, `POST /api/v1/services`) and the two task relationships
// that outlive a create call: dependency edges and attached requirements documents.
//
// Its own controller rather than more of `PublicApiController`, which already carries the whole
// job + task lifecycle and sits at its size budget. The split is also the honest one: everything
// here is about the SHAPE of the board an integration drives, where that file is about running one
// task through it.
//
// Four rules shape it, and each is enforced below rather than merely intended:
//
//  1. **Every write delegates to the SAME service method the SPA's own controller calls**, so an
//     invariant (a monorepo needing a subdirectory, a dependency that would close a cycle, a
//     document another task already holds) cannot differ by which door it came through.
//  2. **Refusals THROW `DomainError`s.** `handleError` is the one producer of the wire envelope on
//     every facade, and only a thrown error can carry the `details.reason` a caller branches on.
//     The AUTH gate is the documented exception everywhere on this surface, which is why these
//     routes use `authorizeOrThrow`: they have no reason to hand-build the one envelope they could.
//  3. **No board COORDINATES.** A service created here is laid out by the board itself. Positions,
//     sizes and reparenting stay out of a surface that is frozen forever.
//  4. **Every read is scoped to the key's workspace and to a BOARD-VISIBLE block**
//     (`getServiceTask`, which excludes the headless job anchors), so a key can never reach a run's
//     internal anchor or another workspace's task through these paths.

/** Project a stored document onto the small attached-document resource. */
function toPublicAttachedDocument(document: SourceDocument): PublicAttachedDocument {
  return {
    source: document.source,
    externalId: document.externalId,
    title: document.title,
    url: document.url,
    excerpt: document.excerpt,
  }
}

/**
 * Resolve a board task the calling key may edit, or throw the 404 that hides everything else.
 *
 * One loader for all four task-relationship routes so the refusal is decided once: an id naming a
 * headless job anchor, another workspace's task, or a frame is not "forbidden" here, it is absent,
 * exactly as `GET /api/v1/tasks/:taskId` already answers.
 */
async function requireTask<E extends AppEnv>(
  c: Context<E>,
  workspaceId: string,
  taskId: string,
): Promise<{ block: Block; service: Block }> {
  const found = await c.get('container').boardService.getServiceTask(workspaceId, taskId)
  if (!found) throw new NotFoundError('Task', taskId, { reason: 'task_not_found' })
  return found
}

/** The document module, or the 503 that names what this deployment has not wired. */
function requireDocuments(container: ServerContainer): NonNullable<ServerContainer['documents']> {
  return requireCapability(container.documents, 'Document-source integration is not configured')
}

export function publicBoardController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  registerProvisioningRoutes(app)
  registerDependencyRoutes(app)
  registerDocumentRoutes(app)
  return app
}

function registerProvisioningRoutes(app: Hono<AppEnv>): void {
  // The repositories a service can be created against. `read` scope: it names what the workspace
  // has already connected, and an integration must be able to see what it is about to ask for
  // without holding the credential that could change it.
  buildHonoRoute(app, listPublicReposContract, async (c) => {
    const auth = await authorizeOrThrow(c, listPublicReposContract.minScope)
    const options = await c.get('container').boardService.listRepoOptions(auth.workspaceId)
    return c.json({ repos: options.map(toPublicRepo) }, 200)
  })

  // Create a service, optionally backed by a repository: the last act of board setup with no
  // headless counterpart. Both branches delegate to the board service, which is where every guard
  // (the account-wide whole-repo dedupe that MOUNTS a shared service rather than duplicating it,
  // the monorepo subdirectory rules) already lives.
  buildHonoRoute(app, createPublicServiceContract, async (c) => {
    const auth = await authorizeOrThrow(c, createPublicServiceContract.minScope)
    const body = c.req.valid('json')
    const block = await createService(c.get('container'), auth.workspaceId, body)
    return c.json(toPublicService(block), 201)
  })
}

/**
 * Create the service frame, with or without a repository behind it.
 *
 * Split out of the route because the two branches read as one decision and the route should show
 * that: `repo` present or absent is the whole of it, and each branch is a single delegate call.
 *
 * The unlinked branch is deliberately reachable rather than an oversight. A frame with no
 * repository holds tasks and runs none of them (execution resolves a task's repository by walking
 * up to its service frame, and refuses when there is nothing there), which is a legitimate
 * intermediate state for a caller mapping out a board before its repositories exist.
 */
async function createService(
  container: ServerContainer,
  workspaceId: string,
  body: CreatePublicServiceInput,
): Promise<Block> {
  const { repo, ...authored } = body
  if (!repo) {
    // `type` is the repo-backed subset (`service` / `frontend` / `library` / `document`), which is
    // a subset of the board's own frame types, so it passes straight through.
    return container.boardService.addFrame(workspaceId, {
      ...authored,
      type: authored.type ?? 'service',
    })
  }
  // Both halves of the monorepo rule (a monorepo service names a subdirectory, a whole-repo one
  // must not) belong to the board service, which is the only layer that knows the flag as it
  // stands AFTER this request's own `monorepo` write. Restating either here would be a second
  // rule reading a value it cannot see: an omitted `monorepo` leaves the stored flag alone, so
  // whether a `directory` is legal is not a fact about the request at all. Both refusals arrive
  // as a `ValidationError` carrying the `reason` a caller branches on.
  //
  // `refuse` is what makes this surface's own reads honest about the answer: see
  // `SharedServicePolicy`.
  return container.boardService.addServiceFromRepo(
    workspaceId,
    {
      ...authored,
      repoGithubId: repo.repoId,
      ...(repo.directory ? { directory: repo.directory } : {}),
      ...(repo.monorepo === undefined ? {} : { isMonorepo: repo.monorepo }),
    },
    'refuse',
  )
}

function registerDependencyRoutes(app: Hono<AppEnv>): void {
  // Declare (or drop) an ordering between two tasks. EXPLICIT rather than the board's own toggle:
  // a provisioning integration re-running its own setup must converge, and a toggle would invert
  // every edge it declared last time, silently, since both calls succeed.
  buildHonoRoute(app, addPublicTaskDependencyContract, async (c) => {
    const auth = await authorizeOrThrow(c, addPublicTaskDependencyContract.minScope)
    const { taskId } = c.req.valid('param')
    const { dependsOnTaskId } = c.req.valid('json')
    return c.json(await writeDependency(c, auth.workspaceId, taskId, dependsOnTaskId, true), 200)
  })

  buildHonoRoute(app, removePublicTaskDependencyContract, async (c) => {
    const auth = await authorizeOrThrow(c, removePublicTaskDependencyContract.minScope)
    const { taskId } = c.req.valid('param')
    const { dependsOnTaskId } = c.req.valid('json')
    return c.json(await writeDependency(c, auth.workspaceId, taskId, dependsOnTaskId, false), 200)
  })
}

/**
 * The body both dependency routes share: resolve the task, admit the blocker, then set the edge.
 *
 * Resolving the blocker is the point of the shared helper, and it is asymmetric on purpose.
 *
 * On an ADD, `setDependency` would resolve it as a BLOCK, which on the board legitimately includes
 * a frame, a module, or a task homed on another workspace that this board merely mounts, none of
 * which this key addresses through `/api/v1/tasks/:taskId`. Without this check a caller could name
 * any block id it happened to learn and have the refusal arrive as "only tasks can have dependency
 * edges", which describes the board's rule rather than the caller's mistake, or worse succeed
 * against a shared task the key cannot read back.
 *
 * On a REMOVE, an edge the task ALREADY CARRIES is removable whether or not its blocker still
 * resolves as a visible task. The blocker can be deleted, archived under a removed service, or a
 * shared task this board only mounts, and every one of those leaves `GET /api/v1/tasks/:taskId`
 * advertising the edge in `dependsOn` with nothing able to drop it: the same requirement-to-
 * converge that made these routes explicit rather than a toggle, one level down. A remove naming
 * an id that is neither a visible task nor a declared edge still 404s, so a transposed pair is
 * still answered with the field that was wrong rather than with a success that did nothing.
 */
async function writeDependency<E extends AppEnv>(
  c: Context<E>,
  workspaceId: string,
  taskId: string,
  dependsOnTaskId: string,
  linked: boolean,
): Promise<PublicTask> {
  const boardService = c.get('container').boardService
  const found = await requireTask(c, workspaceId, taskId)
  // The blocker's own 404 names the field that was wrong, so a caller that transposed two ids is
  // not left comparing two identical refusals.
  const declared = !linked && (found.block.dependsOn ?? []).includes(dependsOnTaskId)
  if (!declared && !(await boardService.getServiceTask(workspaceId, dependsOnTaskId))) {
    throw new NotFoundError('Task', dependsOnTaskId, { reason: 'depends_on_task_not_found' })
  }
  const block = await boardService.setDependency(workspaceId, taskId, dependsOnTaskId, linked)
  return toPublicTask(block, found.service.id)
}

function registerDocumentRoutes(app: Hono<AppEnv>): void {
  // What the task carries, in the order the agents read it.
  buildHonoRoute(app, listPublicTaskDocumentsContract, async (c) => {
    const auth = await authorizeOrThrow(c, listPublicTaskDocumentsContract.minScope)
    const container = c.get('container')
    const { taskId } = c.req.valid('param')
    await requireTask(c, auth.workspaceId, taskId)
    const documents = await requireDocuments(container).linkService.listBlockLinks(
      auth.workspaceId,
      taskId,
    )
    return c.json({ documents: documents.map(toPublicAttachedDocument) }, 200)
  })

  // Attach a spec to a task that already exists: the moment creation could not serve, since a
  // task's spec routinely arrives after the task does.
  buildHonoRoute(app, attachPublicTaskDocumentContract, async (c) => {
    const auth = await authorizeOrThrow(c, attachPublicTaskDocumentContract.minScope)
    const container = c.get('container')
    const { taskId } = c.req.valid('param')
    await requireTask(c, auth.workspaceId, taskId)
    // The SAME two-phase resolve the create path runs, and it matters more here, not less: an
    // `upload` MINTS a document row, so resolving before the task is known to exist is what stops a
    // caller retrying against a mistyped id from filling the workspace with unreachable copies of
    // one spec. There is no block to roll back on this path (the task predates the request), so
    // the ordering IS the whole guard.
    const attachment = await resolveDocuments(
      {
        documents: container.documents,
        boardService: container.boardService,
        logger: container.logger,
      },
      auth.workspaceId,
      [c.req.valid('json').document],
    )
    // The linked row AS STORED, which is what carries the id: an `upload` is minted during the
    // resolve above, so its `externalId` is not something the caller sent and is exactly the value
    // a later detach has to name. Read off the write rather than re-listing the block, which would
    // guess at an ordering the repositories do not promise.
    const [attached] = await attachment.attach(taskId)
    if (!attached) {
      // Unreachable in practice (the resolve above produced exactly one ref), and stated rather
      // than asserted with a `!`: answering with a fabricated row would report a spec the run will
      // never see.
      throw new NotFoundError('Document', taskId, { reason: 'document_attach_unconfirmed' })
    }
    return c.json(toPublicAttachedDocument(attached), 201)
  })

  // Detach one document. Idempotent, and the document itself survives in the workspace.
  buildHonoRoute(app, detachPublicTaskDocumentContract, async (c) => {
    const auth = await authorizeOrThrow(c, detachPublicTaskDocumentContract.minScope)
    const container = c.get('container')
    const { taskId } = c.req.valid('param')
    const { source, externalId } = c.req.valid('json')
    await requireTask(c, auth.workspaceId, taskId)
    await requireDocuments(container).linkService.detachFromBlock(
      auth.workspaceId,
      taskId,
      source,
      externalId,
    )
    return c.body(null, 204)
  })
}
