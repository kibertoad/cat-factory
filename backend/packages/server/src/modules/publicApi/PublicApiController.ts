import {
  type Block,
  actPublicNotificationContract,
  cancelPublicJobContract,
  createPublicJobContract,
  createPublicTaskContract,
  deletePublicTaskContract,
  dismissPublicNotificationContract,
  getPublicJobContract,
  getPublicRunContract,
  getPublicTaskContract,
  getPublicUsageContract,
  listPublicJobsContract,
  listPublicNotificationsContract,
  listPublicPipelinesContract,
  listPublicServiceTasksContract,
  listPublicServicesContract,
  retryPublicTaskContract,
  startPublicTaskContract,
  stopPublicTaskContract,
  updatePublicTaskContract,
  type ExecutionInstance,
  type PublicJob,
  type PublicPipeline,
  type PublicApiScope,
  type PublicRun,
  type PublicService,
  type PublicTask,
} from '@cat-factory/contracts'
import type { AgentKindRegistry } from '@cat-factory/agents'
import {
  CredentialRequiredError,
  inputGateInputOf,
  type InputGateInput,
  runBestEffort,
  UnavailableError,
} from '@cat-factory/kernel'
import { scopeSatisfies } from '@cat-factory/integrations'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import { personalGateForBlock, personalGateForRun } from '../providers/personalCredentialGate.js'
import {
  HEADLESS_ACTIONABLE_NOTIFICATION_TYPES,
  notificationActEffect,
} from '../notifications/notificationActions.js'
import type { AppEnv } from '../../http/env.js'
import { authorize } from './publicApiAuth.js'
import { createTaskWithAttachments, taskCreationDeps } from './taskCreation.js'
import {
  type AdmissiblePipelineShape,
  publicRunParkSurfaces,
  isHeadlessInlinePipeline,
  isInlineOnlyPipeline,
  parkingRefusalMessage,
  PUBLIC_JOB_CANCEL_PATH,
  PUBLIC_TASK_STOP_PATH,
} from './publicApiAdmission.js'
import { createParkAnnouncer, isParked } from './publicApiStream.js'
import {
  decodeCursor,
  decodeTimeCursor,
  encodeCursor,
  internalStatusesFor,
  jobSortKey,
  mapStatus,
} from './publicApiPaging.js'

// The PUBLIC external API (`/api/v1/*`). Unlike the SPA surface it is NOT behind the user-session
// gate (its `/api` prefix is in the authGate bypass list); every route authenticates IN-CONTROLLER
// by a public-API key (`Authorization: Bearer cf_live_…`) resolved to a workspace scope, mirroring
// how `/internal` self-authenticates with a machine token. First use-case: "headless jobs":
// start a public, inline pipeline headlessly (`POST /jobs`) and retrieve its DB-persisted result
// asynchronously (poll `GET /jobs/:id` or stream `GET /jobs/:id/events`). Nothing is pushed to
// GitHub: the pipeline is inline-only, so the run produces its output purely in the DB.
//
// Second use-case: "basic board workloads" — the external counterparts of the SPA's board
// operations, all scoped to the key's workspace: list the workspace's services
// (`GET /services`), create a task under one (`POST /services/:serviceId/tasks`), list a
// service's tasks (`GET /services/:serviceId/tasks`), read a task's status
// (`GET /tasks/:taskId`), and start a task (`POST /tasks/:taskId/start`). Reads project a
// `Block` onto small `publicTask`/`publicService` resources; `start` refuses an
// individual-usage-model task (no headless personal-credential unlock).

/** How often the SSE stream re-reads the job, and the hard cap on how long it stays open. */
const SSE_POLL_MS = 1000
const SSE_MAX_MS = 5 * 60 * 1000
/** Re-verify the caller's key at most this often on a live stream, so a mid-stream revoke cuts it. */
const SSE_REAUTH_MS = 5000

/** Max headless jobs a single workspace may have in flight at once (a public-API
 *  concurrency backstop: bounds the LLM spend one — possibly leaked — key can drive). */
const MAX_ACTIVE_JOB_RUNS = 5

/** Default page sizes when a list request passes no `?limit=`. The hard ceiling (100) is enforced
 *  by the query contract, so a caller can never ask for the whole table in one response. */
const DEFAULT_JOB_PAGE = 25
const DEFAULT_TASK_PAGE = 50

/** Project a persisted execution onto the external job resource (no block/board internals). */
function toPublicJob(execution: ExecutionInstance): PublicJob {
  const status = mapStatus(execution.status)
  // The deliverable is the LAST step that actually produced output — normally the terminal step,
  // but scanning from the end keeps the result meaningful for a multi-step public pipeline whose
  // final step is a side-effect-only tail that emits nothing (the built-in initiative pipeline is
  // single-step, so this simply picks that step). Fall back to the terminal step so a `succeeded`
  // run always carries a (possibly empty) result rather than null.
  const withOutput = [...execution.steps]
    .reverse()
    .find((s) => (s.output ?? '') !== '' || s.custom != null)
  const deliverable = withOutput ?? execution.steps[execution.steps.length - 1]
  const result =
    status === 'succeeded' && deliverable
      ? { output: deliverable.output ?? '', data: deliverable.custom ?? null }
      : null
  const error =
    status === 'failed'
      ? execution.failure
        ? { code: execution.failure.kind, message: execution.failure.message }
        : { code: 'run_failed', message: 'The run failed' }
      : null
  return {
    jobId: execution.id,
    status,
    pipelineId: execution.pipelineId,
    // The run's own creation stamp — the SAME value the list's keyset cursor is minted from
    // (`jobSortKey`), so a caller can page and correlate on one consistent number.
    createdAt: jobSortKey(execution),
    result,
    error,
  }
}

/** Project a board task block onto the external task resource (no block/board internals). */
function toPublicTask(block: Block, serviceId: string): PublicTask {
  return {
    taskId: block.id,
    serviceId,
    title: block.title,
    description: block.description,
    taskType: block.taskType ?? 'feature',
    status: block.status,
    progress: block.progress,
    // The public name is `runId`, one vocabulary with `publicRun.runId` and `/runs/:runId/...`;
    // `executionId` is the internal engine name for the same id.
    runId: block.executionId,
    pullRequestUrl: block.pullRequest?.url ?? null,
  }
}

/** Project a service frame block onto the external service resource. */
function toPublicService(frame: Block): PublicService {
  return {
    serviceId: frame.id,
    title: frame.title,
    description: frame.description,
    type: frame.type,
    status: frame.status,
  }
}

/**
 * Project a task's persisted run + its block onto the RICH external run resource: per-step
 * state/progress/subtasks, the failure kind+message, and the PR (url + branch). The run's
 * `status` is the raw execution status (`running`/`blocked`/`paused`/`done`/`failed`) — the
 * public run view deliberately surfaces the parked states (unlike the coarse `publicJob`), so
 * a caller can tell an awaiting-a-human `blocked` from a still-`running` step. The PR branch
 * lives on the BLOCK (`block.pullRequest`), not the run, so both are joined here.
 */
function toPublicRun(execution: ExecutionInstance, block: Block): PublicRun {
  const pr = block.pullRequest
  return {
    runId: execution.id,
    taskId: block.id,
    status: execution.status,
    createdAt: jobSortKey(execution),
    currentStep: execution.currentStep,
    steps: execution.steps.map((s) => ({
      agentKind: s.agentKind,
      state: s.state,
      progress: s.progress,
      subtasks: s.subtasks
        ? {
            completed: s.subtasks.completed,
            inProgress: s.subtasks.inProgress,
            total: s.subtasks.total,
          }
        : null,
    })),
    pullRequest: pr ? { url: pr.url, branch: pr.branch ?? null } : null,
    error:
      execution.status === 'failed'
        ? execution.failure
          ? { code: execution.failure.kind, message: execution.failure.message }
          : { code: 'run_failed', message: 'The run failed' }
        : null,
  }
}

/**
 * Project an internal pipeline onto the external pipeline resource: its id/name, the enabled
 * step chain (in order), and the two headless-relevant flags a caller needs to choose a
 * `pipelineId` for `start` — `public` (job-startable via `POST /jobs`) and `headlessStartable` (safe to
 * run with no interactive user). Archived pipelines are filtered out by the caller.
 */
function toPublicPipeline(
  pipeline: {
    id: string
    name: string
    agentKinds: string[]
    enabled?: boolean[]
    gates?: boolean[]
    public?: boolean
  },
  registry: AgentKindRegistry,
): PublicPipeline {
  return {
    pipelineId: pipeline.id,
    name: pipeline.name,
    steps: pipeline.agentKinds.filter((_, i) => pipeline.enabled?.[i] !== false),
    public: pipeline.public === true,
    headlessStartable: isHeadlessInlinePipeline(pipeline, registry),
  }
}

/**
 * Load a public JOB by id for an authenticated key: the persisted execution, but ONLY when it is
 * anchored on a HEADLESS internal block (a run this public surface created). Returns null when no
 * such run exists in the key's workspace OR the id points at a normal board execution — so an
 * external key can never read an arbitrary in-workspace run's output, only its own headless jobs.
 * Runtime-symmetric: one `executionRepository.get` + one `boardService.getInternalTask` point-read.
 */
async function loadPublicJob<E extends AppEnv>(
  c: Context<E>,
  workspaceId: string,
  id: string,
): Promise<ExecutionInstance | null> {
  const container = c.get('container')
  const execution = await container.executionRepository.get(workspaceId, id)
  if (!execution) return null
  const anchor = await container.boardService.getInternalTask(workspaceId, execution.blockId)
  return anchor ? execution : null
}

/**
 * Best-effort, event-free rollback of a headless job run: drop the persisted run (the
 * execution + its live-run row, via `deleteByBlock`) THEN the anchor block. Used when a start fails
 * partway or is rolled back over the cap, so nothing survives for the stale-run sweeper to re-drive
 * against a since-deleted block. `deleteByBlock` is the same primitive `ExecutionService.cancel`
 * uses, so it clears whatever `start()` had already committed regardless of how far it got. No board
 * event is emitted (the anchor never renders anyway), so a burst of rollbacks can't fan spurious
 * refreshes out to every workspace client.
 */
async function rollbackInitiativeRun<E extends AppEnv>(
  c: Context<E>,
  workspaceId: string,
  blockId: string,
): Promise<void> {
  const container = c.get('container')
  // A failed rollback leaves an anonymous anchor block + its execution rows behind with nothing
  // pointing at them, so the leak is invisible to every surface — hence the log.
  const fields = { workspaceId, blockId }
  await runBestEffort(
    container.logger,
    'publicApi.rollbackRun',
    () => container.executionRepository.deleteByBlock(workspaceId, blockId),
    fields,
  )
  await runBestEffort(
    container.logger,
    'publicApi.rollbackAnchorBlock',
    () => container.boardService.deleteInternalTask(workspaceId, blockId),
    fields,
  )
}

/**
 * The refusal message when a caller's scope cannot answer the parks a start would set in motion,
 * or `null` when there is nothing to refuse.
 *
 * Shared by both public start surfaces (`POST /jobs` and `POST /tasks/:taskId/start`) because the
 * rule is one rule: a pipeline that can park on a human needs a caller able to answer it, which is
 * exactly what the `decide` scope asserts, and a `write` key gets a refusal naming THIS run's park
 * surfaces (saying so, rather than promising an answer path that does not exist, for any the
 * decision surface cannot answer yet).
 *
 * `gateInput` is what makes it a RUN-level rather than a pipeline-level question: the pre-dispatch
 * input gate parks on the shape of the TASK, so a run under a pipeline that parks nowhere still
 * stops there. The jobs surface passes the shape of the anchor block it is about to create, since
 * the brief becomes that block's description and is exactly what the engine's own check reads a
 * moment later.
 */
async function unanswerableParkRefusal(
  container: AppEnv['Variables']['container'],
  auth: { workspaceId: string; scope: PublicApiScope },
  pipeline: AdmissiblePipelineShape,
  gateInput: InputGateInput,
  cancelPath: string,
): Promise<string | null> {
  const surfaces = publicRunParkSurfaces(pipeline, {
    inputGateBlocks: await container.executionService.inputGateWouldBlock(
      auth.workspaceId,
      gateInput,
    ),
  })
  if (surfaces.length === 0 || scopeSatisfies(auth.scope, 'decide')) return null
  return parkingRefusalMessage(surfaces, { cancelPath })
}

export function publicApiController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  // The route registrations are grouped into cohesive registrars (jobs, board tasks, pipeline
  // discovery, notification inbox) purely so no single function exceeds the size budget; each
  // registers onto the shared `app` and depends only on the module-level helpers above.
  registerJobRoutes(app)
  registerTaskRoutes(app)
  registerPipelineRoutes(app)
  registerNotificationRoutes(app)
  registerUsageRoutes(app)
  return app
}

function registerUsageRoutes(app: Hono<AppEnv>): void {
  // --- Usage & spend ---------------------------------------------------------
  // The read an external dashboard needs to answer "how much has this workspace spent this
  // period, on what, and is it paused?". Two aggregates served as ONE resource: splitting them
  // would let a caller render a breakdown against a budget read a period-roll apart.
  //
  // Both halves are workspace-scoped IN SQL and name no resource ids, no per-user dimension and
  // no credential, so the double-scope rule is satisfied by construction and `read` is the whole
  // scope story. The account/user budget tiers are deliberately NOT reachable here: they are
  // cross-workspace, and a workspace-scoped key must never learn a sibling workspace's spend.
  buildHonoRoute(app, getPublicUsageContract, async (c) => {
    const gate = await authorize(c, 'read')
    if ('fail' in gate) {
      return c.json(
        { error: { code: gate.fail.code, message: gate.fail.message } },
        gate.fail.status,
      )
    }
    const { spendService } = c.get('container')
    // ONE read, not `status()` + `usageBreakdown()`: those each derive their own period from the
    // clock, so a pair of calls straddling the month roll would pair a budget from one period with
    // a breakdown from the next — exactly the skew serving them as one resource is meant to
    // prevent. `periodUsage` resolves the period once and still issues both aggregates
    // concurrently.
    const usage = await spendService.periodUsage(gate.auth.workspaceId)
    return c.json(
      {
        periodStart: usage.periodStart,
        currency: usage.currency,
        budget: {
          inputTokens: usage.budget.inputTokens,
          outputTokens: usage.budget.outputTokens,
          costSpent: usage.budget.costSpent,
          costLimit: usage.budget.costLimit,
          exceeded: usage.budget.exceeded,
        },
        rows: usage.rows.map((row) => ({
          billing: row.billing,
          vendor: row.vendor,
          provider: row.provider,
          model: row.model,
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          costEstimate: row.costEstimate,
          calls: row.calls,
        })),
      },
      200,
    )
  })
}

function registerJobRoutes(app: Hono<AppEnv>): void {
  // Start a headless job: validate the pipeline is public + inline, create a headless internal
  // block to anchor the run, and start it. Returns 202 with the job id + follow-up links.
  buildHonoRoute(app, createPublicJobContract, async (c) => {
    const gate = await authorize(c, 'write')
    if ('fail' in gate) {
      return c.json(
        { error: { code: gate.fail.code, message: gate.fail.message } },
        gate.fail.status,
      )
    }
    const { auth } = gate
    const container = c.get('container')
    const { pipelineId, input, title } = c.req.valid('json')

    // `resolveForRun`, not the stored row: what this admits must be what `start` runs, and `start`
    // ADOPTS a catalog built-in the board was never seeded with. `pl_initiative` is public AND
    // parking, so reading the row alone both refused a legitimate job on a board older than that
    // pipeline and, worse, would have let the parking check below run against nothing.
    const pipeline = await container.pipelineService.resolveForRun(auth.workspaceId, pipelineId)
    if (!pipeline || !pipeline.public) {
      return c.json(
        { error: { code: 'pipeline_not_public', message: 'Unknown or non-public pipeline' } },
        400,
      )
    }
    // Defense in depth: a public pipeline must be inline-only, so an external run can never
    // trigger container work or a GitHub push. This half is absolute — no scope lifts it.
    if (!isInlineOnlyPipeline(pipeline, container.agentKindRegistry)) {
      return c.json(
        { error: { code: 'pipeline_not_inline', message: 'Public pipeline must be inline' } },
        400,
      )
    }
    // The parking half is a SCOPE question (see `unanswerableParkRefusal`). The input gate is
    // asked about the anchor block created below, since the brief becomes its description.
    const parkRefusal = await unanswerableParkRefusal(
      container,
      auth,
      pipeline,
      { title: title?.trim() || input.slice(0, 80), description: input, level: 'task' },
      PUBLIC_JOB_CANCEL_PATH,
    )
    if (parkRefusal) {
      return c.json(
        { error: { code: 'pipeline_requires_decide_scope', message: parkRefusal } },
        403,
      )
    }

    // Concurrency backstop: cap the workspace's in-flight external runs so a leaked/abusive key
    // can't spin up unbounded LLM work. Counted in SQL, checked before the run is created.
    const active = await container.boardService.countActiveInternalTasks(auth.workspaceId)
    if (active >= MAX_ACTIVE_JOB_RUNS) {
      return c.json(
        {
          error: {
            code: 'too_many_active_runs',
            message: `This workspace already has ${MAX_ACTIVE_JOB_RUNS} headless jobs in flight; wait for one to finish`,
          },
        },
        429,
      )
    }

    const block = await container.boardService.createInternalTask(auth.workspaceId, {
      title: title?.trim() || input.slice(0, 80),
      description: input,
    })
    // Headless / system-initiated: no `usr_*` initiator (an inline public run never leases a
    // personal credential), so pass null rather than a synthetic user id. If start fails, roll the
    // whole run back: `ExecutionService.start` persists the execution + live-run row and flips the
    // block to `in_progress` BEFORE its throwing dispatch (`workRunner.startRun`), so deleting only
    // the anchor block would orphan a `running` execution the stale-run sweeper then re-drives
    // forever against a since-deleted block. `rollbackInitiativeRun` drops the execution first, then
    // the block, so a failed dispatch leaves nothing behind (whether it threw before or after the
    // rows were written).
    let execution: ExecutionInstance
    try {
      execution = await container.executionService.start(auth.workspaceId, block.id, pipelineId, {
        initiatedBy: null,
        intakeOrigin: 'public-api',
      })
    } catch (err) {
      await rollbackInitiativeRun(c, auth.workspaceId, block.id)
      throw err
    }

    // Close the check-then-act race on the cap. The pre-check above is a fast path, but it can let
    // several concurrent requests through before any of their anchors flips to `in_progress` (the
    // count only sees `in_progress` internal blocks). Re-count now that THIS run is in flight; if
    // concurrent starts pushed the workspace past the cap, roll this one back and 429, so the
    // backstop holds under a parallel burst and not merely sequentially. Strict `>` keeps the
    // sequential case exact (the Nth start that lands on the cap boundary still succeeds).
    const activeNow = await container.boardService.countActiveInternalTasks(auth.workspaceId)
    if (activeNow > MAX_ACTIVE_JOB_RUNS) {
      await rollbackInitiativeRun(c, auth.workspaceId, block.id)
      return c.json(
        {
          error: {
            code: 'too_many_active_runs',
            message: `This workspace already has ${MAX_ACTIVE_JOB_RUNS} headless jobs in flight; wait for one to finish`,
          },
        },
        429,
      )
    }
    return c.json(
      {
        jobId: execution.id,
        status: mapStatus(execution.status),
        links: {
          self: `/api/v1/jobs/${execution.id}`,
          events: `/api/v1/jobs/${execution.id}/events`,
        },
      },
      202,
    )
  })

  // List the workspace's headless jobs, newest first. Closes the gap where an
  // integration that lost its stored job ids (a restart, a redeploy) could never re-discover its
  // own in-flight runs, since `GET /jobs/:id` needs an id it no longer has. The `internal` scope
  // is applied IN SQL by `listInternal` (the list form of `loadPublicJob`'s double-scope), so it
  // can never enumerate the workspace's ordinary board runs.
  buildHonoRoute(app, listPublicJobsContract, async (c) => {
    const gate = await authorize(c, 'read')
    if ('fail' in gate) {
      return c.json(
        { error: { code: gate.fail.code, message: gate.fail.message } },
        gate.fail.status,
      )
    }
    const query = c.req.valid('query')
    const limit = query.limit ?? DEFAULT_JOB_PAGE
    // A malformed cursor is a 400, never a silent fall back to page 1 — a client paging on a
    // corrupted cursor would otherwise re-serve the first page forever with no error to act on.
    let cursor: { createdAt: number; id: string } | undefined
    if (query.cursor) {
      const decoded = decodeTimeCursor(query.cursor)
      if (!decoded) {
        return c.json({ error: { code: 'invalid_cursor', message: 'Malformed cursor' } }, 400)
      }
      cursor = decoded
    }
    // Ask for one extra row so "is there another page" needs no second query.
    const rows = await c.get('container').executionRepository.listInternal(gate.auth.workspaceId, {
      limit: limit + 1,
      cursor,
      statuses: query.status ? internalStatusesFor(query.status) : undefined,
      since: query.since,
    })
    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const last = page[page.length - 1]
    return c.json(
      {
        jobs: page.map(toPublicJob),
        // The cursor rides the SAME `(createdAt, id)` composite the repository orders and filters
        // on, so a burst of runs sharing a millisecond pages correctly instead of losing the ties.
        // `jobSortKey` is that shared definition — the sort key here is by construction the value
        // `agent_runs.created_at` holds for this row, never a second stamp taken elsewhere.
        nextCursor: hasMore && last ? encodeCursor(jobSortKey(last), last.id) : null,
      },
      200,
    )
  })

  // Poll a job's status + result. Scoped to the key's workspace AND to headless job runs
  // (see loadPublicJob), so a job in another workspace — or a normal board run — is a 404.
  buildHonoRoute(app, getPublicJobContract, async (c) => {
    const gate = await authorize(c, 'read')
    if ('fail' in gate) {
      return c.json(
        { error: { code: gate.fail.code, message: gate.fail.message } },
        gate.fail.status,
      )
    }
    const execution = await loadPublicJob(c, gate.auth.workspaceId, c.req.valid('param').id)
    if (!execution) {
      return c.json({ error: { code: 'not_found', message: 'Job not found' } }, 404)
    }
    return c.json(toPublicJob(execution), 200)
  })

  // Cancel a headless job run. This is what makes admitting a PARKING pipeline safe (see
  // PARKING_INLINE_KINDS): a parked run waits for a human indefinitely while its anchor holds one
  // of the workspace's MAX_ACTIVE_JOB_RUNS slots, so a caller that decides not to answer
  // must be able to free it — otherwise the concurrency cap is a wall with no door. Delegates to
  // the SAME `stopRun` the board `stop` route uses: idempotent (a terminal run comes back as-is)
  // and it records a `cancelled` terminal state rather than deleting the run, so the job stays
  // readable afterwards. `write` (not `decide`): giving up on your own run is an ordinary
  // mutation, and a caller must never be locked out of cleaning up work it started.
  buildHonoRoute(app, cancelPublicJobContract, async (c) => {
    const gate = await authorize(c, 'write')
    if ('fail' in gate) {
      return c.json(
        { error: { code: gate.fail.code, message: gate.fail.message } },
        gate.fail.status,
      )
    }
    const { auth } = gate
    const { id } = c.req.valid('param')
    // Same headless-job scoping as the poll read: only a headless run this surface created.
    const execution = await loadPublicJob(c, auth.workspaceId, id)
    if (!execution) {
      return c.json({ error: { code: 'not_found', message: 'Job not found' } }, 404)
    }
    const stopped = await c.get('container').executionService.stopRun(auth.workspaceId, id)
    return c.json(toPublicJob(stopped), 200)
  })

  registerJobStreamRoute(app)
}

function registerJobStreamRoute(app: Hono<AppEnv>): void {
  // Stream a job's progress + terminal completion over SSE. Implemented as a bounded poll over the
  // persisted execution (runtime-symmetric by construction — no per-facade event-hub wiring), so
  // it serves identically on the Worker and Node. Authenticated by the API key header (an external
  // client can set headers, unlike a browser EventSource). Not a JSON contract, so a raw route —
  // and its own registrar, so the job group stays inside the function-size budget.
  app.get('/api/v1/jobs/:id/events', async (c) => {
    const gate = await authorize(c, 'read')
    if ('fail' in gate) {
      return c.json(
        { error: { code: gate.fail.code, message: gate.fail.message } },
        gate.fail.status,
      )
    }
    const { auth } = gate
    const id = c.req.param('id')
    const container = c.get('container')
    // Same headless-job scoping as the poll read: only a headless run this surface created.
    const initial = await loadPublicJob(c, auth.workspaceId, id)
    if (!initial) {
      return c.json({ error: { code: 'not_found', message: 'Job not found' } }, 404)
    }
    const keys = container.publicApiKeys
    return streamSSE(c, async (stream) => {
      const startedAt = Date.now()
      let lastAuthCheck = Date.now()
      let last = ''
      // Emit the initial state immediately, then poll until terminal / client-gone / revoked /
      // timeout. A `blocked` run is a PARK awaiting a human decision — no longer a dead end, since
      // a `decide`-scope caller can answer it over `/api/v1/runs/:runId/decisions` — so the stream
      // announces the park and keeps watching rather than closing on it.
      const parks = createParkAnnouncer()
      for (;;) {
        if (stream.aborted) break
        // Re-verify the key periodically so a mid-stream revoke cuts the connection (the key was
        // only proven once, at open). Cheap non-hashing revocation check, throttled.
        if (keys && Date.now() - lastAuthCheck > SSE_REAUTH_MS) {
          if (!(await keys.isActive(auth.keyId))) break
          lastAuthCheck = Date.now()
        }
        const execution = await container.executionRepository.get(auth.workspaceId, id)
        if (!execution) break
        const job = toPublicJob(execution)
        const data = JSON.stringify(job)
        if (data !== last) {
          await stream.writeSSE({
            event:
              job.status === 'succeeded' ? 'done' : job.status === 'failed' ? 'error' : 'progress',
            data,
          })
          last = data
        }
        // A `blocked` run has PARKED on a human decision. Announce it once (so a caller learns of
        // the park by push rather than by polling the decisions endpoint on a timer) and keep the
        // stream open — the park is answerable, and answering resumes the very run being watched,
        // which the caller should see through the SAME connection. Announced once per park rather
        // than every tick, so a long park doesn't spam identical frames; re-armed when the run
        // resumes, so a second park later in the pipeline is announced too.
        if (parks.shouldAnnounce(execution.status)) {
          await stream.writeSSE({ event: 'decision', data })
        }
        // A `paused` run is NOT terminal — the spend gate pauses a run when the workspace budget
        // is exhausted and RESUMES it once budget frees up (ExecutionService.evaluateStep), so keep
        // polling (bounded by SSE_MAX_MS below) rather than signalling a false terminal stop.
        // `blocked` is likewise non-terminal now (see above).
        if (
          execution.status !== 'running' &&
          execution.status !== 'paused' &&
          !isParked(execution.status)
        ) {
          // The run has stopped. When it ended in a terminal public status (succeeded/failed) the
          // event above already carried `done`/`error`. A raw status that maps to `running` but is
          // neither terminal nor a park (a `cancelled` stop lands as `failed`, so this is the
          // belt-and-braces arm) would otherwise close the stream after a `progress` frame, leaving
          // the client unable to tell "terminal" from "connection dropped". Emit an explicit
          // terminal `stopped` frame so every close is unambiguous.
          if (job.status === 'running') await stream.writeSSE({ event: 'stopped', data })
          break
        }
        if (Date.now() - startedAt > SSE_MAX_MS) {
          // Bound the connection; the client can reconnect to keep watching.
          await stream.writeSSE({ event: 'timeout', data: '{}' })
          break
        }
        await stream.sleep(SSE_POLL_MS)
      }
    })
  })
}

function registerTaskRoutes(app: Hono<AppEnv>): void {
  // --- Basic board workloads: services + tasks -------------------------------
  // The external counterparts of the SPA's board operations, scoped to the key's workspace
  // via `resolveKey`. Reads project a `Block` onto the small `publicTask`/`publicService`
  // resources (never the raw block). `start` runs a task's pipeline headlessly (no human in
  // the loop): it refuses an individual-usage-model task, which needs a personal-credential
  // unlock only an interactive user can supply.

  // List the workspace's services (board service frames).
  buildHonoRoute(app, listPublicServicesContract, async (c) => {
    const gate = await authorize(c, 'read')
    if ('fail' in gate) {
      return c.json(
        { error: { code: gate.fail.code, message: gate.fail.message } },
        gate.fail.status,
      )
    }
    const services = await c.get('container').boardService.listServices(gate.auth.workspaceId)
    return c.json({ services: services.map(toPublicService) }, 200)
  })

  // Create a task under a service, optionally FROM a tracker ticket and/or WITH the requirements
  // documents the work is to be built against. The ordering of those attachments IS the contract
  // and lives in `taskCreation.ts`, which is where to read before changing any of it.
  buildHonoRoute(app, createPublicTaskContract, async (c) => {
    const gate = await authorize(c, 'write')
    if ('fail' in gate) {
      return c.json(
        { error: { code: gate.fail.code, message: gate.fail.message } },
        gate.fail.status,
      )
    }
    const { serviceId } = c.req.valid('param')
    const block = await createTaskWithAttachments(
      taskCreationDeps(c.get('container')),
      gate.auth.workspaceId,
      serviceId,
      c.req.valid('json'),
    )
    return c.json(toPublicTask(block, serviceId), 201)
  })

  // List a service's tasks (whole subtree, headless anchors excluded) — ONE bounded, keyset-
  // paginated page, optionally filtered to a status. Previously unbounded: it read the entire
  // board and filtered the subtree in JS, so a large service returned every task in one response
  // and paid a full board read per request. `listServiceTasksPage` pushes the bound, the subtree
  // and the status filter into SQL. Ordering is by the stable task id (blocks carry no
  // timestamp), which is why there is no `since` filter here — see the query contract.
  buildHonoRoute(app, listPublicServiceTasksContract, async (c) => {
    const gate = await authorize(c, 'read')
    if ('fail' in gate) {
      return c.json(
        { error: { code: gate.fail.code, message: gate.fail.message } },
        gate.fail.status,
      )
    }
    const { serviceId } = c.req.valid('param')
    const query = c.req.valid('query')
    // A malformed cursor is a 400, never a silent page 1 (see the jobs list for the rationale).
    let afterId: string | undefined
    if (query.cursor) {
      const decoded = decodeCursor(query.cursor)
      if (!decoded) {
        return c.json({ error: { code: 'invalid_cursor', message: 'Malformed cursor' } }, 400)
      }
      afterId = decoded.id
    }
    const page = await c
      .get('container')
      .boardService.listServiceTasksPage(gate.auth.workspaceId, serviceId, {
        limit: query.limit ?? DEFAULT_TASK_PAGE,
        afterId,
        status: query.status,
      })
    if (!page) {
      return c.json({ error: { code: 'not_found', message: 'Service not found' } }, 404)
    }
    const last = page.tasks[page.tasks.length - 1]
    return c.json(
      {
        tasks: page.tasks.map((t) => toPublicTask(t, serviceId)),
        // The sort key IS the id here, so the cursor carries it in both halves — keeping one
        // cursor shape across every list on this surface.
        nextCursor: page.hasMore && last ? encodeCursor(last.id, last.id) : null,
      },
      200,
    )
  })

  // Get a task's status.
  buildHonoRoute(app, getPublicTaskContract, async (c) => {
    const gate = await authorize(c, 'read')
    if ('fail' in gate) {
      return c.json(
        { error: { code: gate.fail.code, message: gate.fail.message } },
        gate.fail.status,
      )
    }
    const found = await c
      .get('container')
      .boardService.getServiceTask(gate.auth.workspaceId, c.req.valid('param').taskId)
    if (!found) {
      return c.json({ error: { code: 'not_found', message: 'Task not found' } }, 404)
    }
    return c.json(toPublicTask(found.block, found.service.id), 200)
  })

  // Start (run) a task.
  buildHonoRoute(app, startPublicTaskContract, async (c) => {
    const gate = await authorize(c, 'write')
    if ('fail' in gate) {
      return c.json(
        { error: { code: gate.fail.code, message: gate.fail.message } },
        gate.fail.status,
      )
    }
    const { auth } = gate
    const container = c.get('container')
    const { taskId } = c.req.valid('param')
    const found = await container.boardService.getServiceTask(auth.workspaceId, taskId)
    if (!found) {
      return c.json({ error: { code: 'not_found', message: 'Task not found' } }, 404)
    }
    // A task under an ARCHIVED service is still READABLE (poll a run that was in flight when the
    // service was archived) but not START-able — consistent with `listServiceTasks`, which hides
    // an archived service entirely, and with `addServiceTask`, which refuses to add work to one.
    if (found.service.archived) {
      return c.json(
        {
          error: {
            code: 'service_archived',
            message: 'This task belongs to an archived service and cannot be started',
          },
        },
        409,
      )
    }
    // The pipeline to run: the request's, else the task's pinned pipeline. A task with
    // neither can't be started headlessly (there is no run-time picker for an API caller).
    const pipelineId = c.req.valid('json').pipelineId ?? found.block.pipelineId
    if (!pipelineId) {
      return c.json(
        {
          error: {
            code: 'pipeline_required',
            message: 'This task has no pipeline; pass a pipelineId to start it',
          },
        },
        400,
      )
    }
    // The SAME parking rule as `POST /jobs`: a pipeline that can park the run on a human
    // decision (an approval gate on an enabled step, a review/brainstorm kind, or an
    // unbounded human-wait gate like `human-review`) needs a caller able to answer it, which
    // is what the `decide` scope asserts. This start path used to apply no pipeline admission
    // at all, so a plain `write` key (one deliberately NOT granted `decide`) could create
    // exactly the parked run the scope ladder says it must not oversee. Board runs stay
    // visible in the SPA, so a human can still answer them there; the rule is about what the
    // KEY may set in motion, not about recoverability.
    //
    // Resolved through the SAME question `ExecutionService.start` answers (`resolveForRun`), which
    // includes a catalog built-in this board has never adopted, so what is ADMITTED and what is RUN
    // cannot be two different definitions. Reading the stored row instead was a live hole rather
    // than a nicety: an un-adopted pipeline answered `null`, this check was skipped for want of
    // anything to inspect, and `start` then adopted and ran it, so a `write`-only key could park a
    // run after all. An id NOTHING defines still resolves to null and still fails inside `start`.
    const boardPipeline = await container.pipelineService.resolveForRun(
      auth.workspaceId,
      pipelineId,
    )
    // Same rule as `POST /jobs` (see `unanswerableParkRefusal`), with THIS task's own input.
    const taskParkRefusal = boardPipeline
      ? await unanswerableParkRefusal(
          container,
          auth,
          boardPipeline,
          inputGateInputOf(found.block),
          PUBLIC_TASK_STOP_PATH,
        )
      : null
    if (taskParkRefusal) {
      return c.json(
        { error: { code: 'pipeline_requires_decide_scope', message: taskParkRefusal } },
        403,
      )
    }
    // A headless key has no user/password to unlock a personal (individual-usage)
    // subscription, so refuse a task whose model resolves to such a vendor (Claude / Codex)
    // up front. The gate throws `CredentialRequiredError` (→ 428) for exactly that case; it
    // is a no-op for an ordinary poolable model. Passing no user means only subscription-ONLY
    // vendors gate (a dual-mode GLM task still runs on the poolable Cloudflare base).
    try {
      await personalGateForBlock(
        container,
        auth.workspaceId,
        taskId,
        pipelineId,
        undefined,
        undefined,
      )
    } catch (err) {
      if (err instanceof CredentialRequiredError) {
        return c.json(
          {
            error: {
              code: 'individual_model_unsupported',
              message:
                'This task runs on an individual-usage model that needs an interactive personal-credential unlock; it cannot be started through the API',
            },
          },
          409,
        )
      }
      throw err
    }
    // Headless / system-initiated: no `usr_*` initiator. The engine's own start-time gates
    // (per-service running-task cap, dependency gate, runnability) apply as for any board start;
    // their `DomainError`s map to the right HTTP status via the shared error handler. This is the
    // abuse backstop for board starts — the analogue of the jobs surface's active-run cap.
    await container.executionService.start(auth.workspaceId, taskId, pipelineId, {
      initiatedBy: null,
      intakeOrigin: 'public-api',
    })
    // Re-read the task so the caller gets its AUTHORITATIVE post-start projection (status,
    // executionId, progress) rather than an optimistic guess — a run may park/block at its first
    // step rather than land on `in_progress`. `getServiceTask` never returns null here (start did
    // not delete the block), but fall back to the pre-start projection if the row is somehow gone.
    const after = await container.boardService.getServiceTask(auth.workspaceId, taskId)
    const projected = after ?? found
    return c.json(toPublicTask(projected.block, projected.service.id), 202)
  })

  registerTaskLifecycleRoutes(app)
}

function registerTaskLifecycleRoutes(app: Hono<AppEnv>): void {
  // --- Task lifecycle: edit / stop / retry / run projection / live stream -----
  // The external counterparts of the SPA's task-lifecycle operations, each double-scoped
  // to the key's workspace AND to a real board task (`getServiceTask`, which excludes
  // headless anchors) — so an external key can never edit/stop/retry/read an arbitrary
  // in-workspace run. Each delegates to the SAME service method the SPA uses; no new logic.

  // Edit a task's title/description. Intended for pre-start authoring, but — like the SPA's
  // inline edit and the underlying `updateBlock` — it is NOT restricted to the pre-start
  // window; editing a running/finished task's title/description does not re-drive the run.
  buildHonoRoute(app, updatePublicTaskContract, async (c) => {
    const gate = await authorize(c, 'write')
    if ('fail' in gate) {
      return c.json(
        { error: { code: gate.fail.code, message: gate.fail.message } },
        gate.fail.status,
      )
    }
    const { auth } = gate
    const container = c.get('container')
    const { taskId } = c.req.valid('param')
    const found = await container.boardService.getServiceTask(auth.workspaceId, taskId)
    if (!found) {
      return c.json({ error: { code: 'not_found', message: 'Task not found' } }, 404)
    }
    const block = await container.boardService.updateBlock(
      auth.workspaceId,
      taskId,
      c.req.valid('json'),
    )
    return c.json(toPublicTask(block, found.service.id), 200)
  })

  // Stop a task's in-flight run. `stopRun` is keyed by run id and idempotent (a terminal
  // run is returned as-is): it records a `cancelled` terminal state on the run rather than
  // deleting it, so the run stays retryable (composing with the retry endpoint below).
  buildHonoRoute(app, stopPublicTaskContract, async (c) => {
    const gate = await authorize(c, 'write')
    if ('fail' in gate) {
      return c.json(
        { error: { code: gate.fail.code, message: gate.fail.message } },
        gate.fail.status,
      )
    }
    const { auth } = gate
    const container = c.get('container')
    const { taskId } = c.req.valid('param')
    const found = await container.boardService.getServiceTask(auth.workspaceId, taskId)
    if (!found) {
      return c.json({ error: { code: 'not_found', message: 'Task not found' } }, 404)
    }
    const run = await container.executionRepository.getByBlock(auth.workspaceId, taskId)
    if (!run) {
      return c.json({ error: { code: 'no_run', message: 'Task has no run to stop' } }, 409)
    }
    await container.executionService.stopRun(auth.workspaceId, run.id)
    // Re-read for the authoritative post-stop projection (a stopped run leaves the block
    // `blocked` with the run retryable).
    const after = await container.boardService.getServiceTask(auth.workspaceId, taskId)
    const projected = after ?? found
    return c.json(toPublicTask(projected.block, projected.service.id), 200)
  })

  // Retry a task's failed run. Mirrors the jobs/start refusals: a headless key has no
  // user/password to unlock an individual-usage (personal) subscription, so refuse a run
  // whose model resolves to such a vendor up front (→ 409). Uses `personalGateForRun` (the
  // same primitive the SPA retry path uses): it resolves the individual vendors from the
  // run's STORED steps — what the retry actually re-drives — rather than re-deriving them
  // from the current pipeline definition (which may have drifted), matching how
  // `ExecutionService.retry` validates. The engine's `retry` then throws `run_not_retryable`
  // (→ 409) unless the run actually failed.
  buildHonoRoute(app, retryPublicTaskContract, async (c) => {
    const gate = await authorize(c, 'write')
    if ('fail' in gate) {
      return c.json(
        { error: { code: gate.fail.code, message: gate.fail.message } },
        gate.fail.status,
      )
    }
    const { auth } = gate
    const container = c.get('container')
    const { taskId } = c.req.valid('param')
    const found = await container.boardService.getServiceTask(auth.workspaceId, taskId)
    if (!found) {
      return c.json({ error: { code: 'not_found', message: 'Task not found' } }, 404)
    }
    const run = await container.executionRepository.getByBlock(auth.workspaceId, taskId)
    if (!run) {
      return c.json({ error: { code: 'no_run', message: 'Task has no run to retry' } }, 409)
    }
    try {
      await personalGateForRun(container, auth.workspaceId, run.id, undefined, undefined)
    } catch (err) {
      if (err instanceof CredentialRequiredError) {
        return c.json(
          {
            error: {
              code: 'individual_model_unsupported',
              message:
                'This task runs on an individual-usage model that needs an interactive personal-credential unlock; it cannot be retried through the API',
            },
          },
          409,
        )
      }
      throw err
    }
    // Headless / system-initiated: no `usr_*` initiator and no personal-credential activation
    // (the gate above already refused the only case that would need one). A non-failed run is
    // rejected inside `retry` with `run_not_retryable` → 409 via the shared error handler.
    await container.executionService.retry(auth.workspaceId, run.id, null, undefined)
    const after = await container.boardService.getServiceTask(auth.workspaceId, taskId)
    const projected = after ?? found
    return c.json(toPublicTask(projected.block, projected.service.id), 202)
  })

  // Read a task's rich run projection: per-step status/progress/subtasks, failure kind+message,
  // and the PR (url + branch). A larger projection than the coarse task status — for a caller
  // that wants to render live run progress or diagnose a failure.
  buildHonoRoute(app, getPublicRunContract, async (c) => {
    const gate = await authorize(c, 'read')
    if ('fail' in gate) {
      return c.json(
        { error: { code: gate.fail.code, message: gate.fail.message } },
        gate.fail.status,
      )
    }
    const { auth } = gate
    const container = c.get('container')
    const { taskId } = c.req.valid('param')
    const found = await container.boardService.getServiceTask(auth.workspaceId, taskId)
    if (!found) {
      return c.json({ error: { code: 'not_found', message: 'Task not found' } }, 404)
    }
    const run = await container.executionRepository.getByBlock(auth.workspaceId, taskId)
    if (!run) {
      return c.json({ error: { code: 'no_run', message: 'Task has not been started' } }, 404)
    }
    return c.json(toPublicRun(run, found.block), 200)
  })

  // Delete a task (and its run history). DESTRUCTIVE, so it requires an `admin`-scoped key (the
  // top of the ladder) — a `read`/`write` key gets 403 `insufficient_scope`. Double-scoped to the
  // key's workspace AND a real board task (`getServiceTask` excludes headless anchors, so an
  // external key can never delete an arbitrary in-workspace block), then delegates to the SAME
  // teardown-then-`removeBlock` sequence the SPA delete uses (`BoardController` remove) —
  // idempotent. `teardownForBlockTree` FIRST kills any running container + durable driver and
  // drops the run record so deleting a *running* task never orphans a container that would idle
  // until its watchdog; it also hands back the board list it loaded so `removeBlock` reuses it
  // instead of paying a second full board read on the same DELETE. (A leaf task is always
  // deletable; the unfinished-work guard in `removeBlock` only protects top-level service frames,
  // which this task-scoped route never targets.)
  buildHonoRoute(app, deletePublicTaskContract, async (c) => {
    const gate = await authorize(c, 'admin')
    if ('fail' in gate) {
      return c.json(
        { error: { code: gate.fail.code, message: gate.fail.message } },
        gate.fail.status,
      )
    }
    const { auth } = gate
    const container = c.get('container')
    const { taskId } = c.req.valid('param')
    const found = await container.boardService.getServiceTask(auth.workspaceId, taskId)
    if (!found) {
      return c.json({ error: { code: 'not_found', message: 'Task not found' } }, 404)
    }
    const preloaded = await container.executionService.teardownForBlockTree(
      auth.workspaceId,
      taskId,
    )
    await container.boardService.removeBlock(auth.workspaceId, taskId, { preloaded })
    return c.body(null, 204)
  })

  registerTaskRunStreamRoute(app)
}

/**
 * The task run SSE stream. Split out of {@link registerTaskLifecycleRoutes} purely for size — the
 * bounded-poll loop is the bulk of that registrar — and registered onto the SAME app instance.
 */
function registerTaskRunStreamRoute(app: Hono<AppEnv>): void {
  // Stream a task's run over SSE: the same bounded-poll pattern as the jobs stream (runtime-
  // symmetric by construction — no per-facade event-hub wiring), re-reading the persisted run
  // + its block each tick so a mid-run PR-open surfaces. Terminal on `done`/`failed`; a parked
  // `blocked`/`paused` keeps polling until the run resumes or the connection hits SSE_MAX_MS.
  app.get('/api/v1/tasks/:taskId/events', async (c) => {
    const gate = await authorize(c, 'read')
    if ('fail' in gate) {
      return c.json(
        { error: { code: gate.fail.code, message: gate.fail.message } },
        gate.fail.status,
      )
    }
    const { auth } = gate
    const taskId = c.req.param('taskId')
    const container = c.get('container')
    const found = await container.boardService.getServiceTask(auth.workspaceId, taskId)
    if (!found) {
      return c.json({ error: { code: 'not_found', message: 'Task not found' } }, 404)
    }
    const run = await container.executionRepository.getByBlock(auth.workspaceId, taskId)
    if (!run) {
      return c.json({ error: { code: 'no_run', message: 'Task has not been started' } }, 404)
    }
    const runId = run.id
    const keys = container.publicApiKeys
    return streamSSE(c, async (stream) => {
      const startedAt = Date.now()
      let lastAuthCheck = Date.now()
      let last = ''
      // Announce a park once per park (see the jobs stream for the rationale); re-armed on resume
      // so a later step's park is announced too.
      const parks = createParkAnnouncer()
      for (;;) {
        if (stream.aborted) break
        if (keys && Date.now() - lastAuthCheck > SSE_REAUTH_MS) {
          if (!(await keys.isActive(auth.keyId))) break
          lastAuthCheck = Date.now()
        }
        const execution = await container.executionRepository.get(auth.workspaceId, runId)
        // Re-read the block for the current PR/branch — the run opens the PR mid-flight, so
        // the block (not the execution) carries it.
        const block = await container.boardService.getServiceTask(auth.workspaceId, taskId)
        if (!execution || !block) break
        const runView = toPublicRun(execution, block.block)
        const data = JSON.stringify(runView)
        if (data !== last) {
          await stream.writeSSE({
            event:
              runView.status === 'done'
                ? 'done'
                : runView.status === 'failed'
                  ? 'error'
                  : 'progress',
            data,
          })
          last = data
        }
        // A `blocked` run has PARKED on a human decision (a requirements/clarity review, a
        // brainstorm, an approval gate, a fork choice). Push it as a distinct `decision` frame so
        // the caller reacts to the park instead of inferring it from a `progress` payload whose
        // status happens to read `blocked`; `GET /api/v1/runs/:runId/decisions` then carries what
        // is actually being asked. The stream stays open across the park — answering resumes this
        // very run, and the caller should see that on the same connection.
        if (parks.shouldAnnounce(execution.status)) {
          await stream.writeSSE({ event: 'decision', data })
        }
        if (execution.status === 'done' || execution.status === 'failed') break
        if (Date.now() - startedAt > SSE_MAX_MS) {
          await stream.writeSSE({ event: 'timeout', data: '{}' })
          break
        }
        await stream.sleep(SSE_POLL_MS)
      }
    })
  })
}

function registerPipelineRoutes(app: Hono<AppEnv>): void {
  // --- Pipeline discovery ----------------------------------------------------
  // List the workspace's pipelines so a caller can discover a valid `pipelineId` for `start`
  // (closing the `pipeline_required`-with-no-way-to-discover gap) and whether each is safe to
  // run headlessly. Archived pipelines are hidden.
  buildHonoRoute(app, listPublicPipelinesContract, async (c) => {
    const gate = await authorize(c, 'read')
    if ('fail' in gate) {
      return c.json(
        { error: { code: gate.fail.code, message: gate.fail.message } },
        gate.fail.status,
      )
    }
    const container = c.get('container')
    const pipelines = await container.pipelineService.list(gate.auth.workspaceId)
    return c.json(
      {
        pipelines: pipelines
          .filter((p) => !p.archived)
          .map((p) => toPublicPipeline(p, container.agentKindRegistry)),
      },
      200,
    )
  })
}

function registerNotificationRoutes(app: Hono<AppEnv>): void {
  // --- Notification inbox: merge / confirm / retry the run tails --------------
  // The external counterparts of the SPA's notification inbox — the operational capstone
  // of the task lifecycle. A run can end parked on a human decision it raised as a
  // notification (a `merger` scored a PR outside auto-merge thresholds → `merge_review`; a
  // merger-less pipeline finished → `pipeline_complete`; the ci-/test-fixer exhausted its
  // budget → `ci_failed`/`test_failed`). These let an external CI/bot resolve those tails
  // (merge / retry / dismiss) instead of only being able to start + watch a task. Each is
  // workspace-scoped by the key (the service methods take the key's workspace id, so a
  // notification in another workspace — or an unknown id — is a 404).

  // List the workspace's OPEN notifications (the inbox). The set is naturally bounded (only
  // `open` cards, resolved by a human), so it is unpaginated like the SPA inbox it mirrors.
  buildHonoRoute(app, listPublicNotificationsContract, async (c) => {
    const gate = await authorize(c, 'read')
    if ('fail' in gate) {
      return c.json(
        { error: { code: gate.fail.code, message: gate.fail.message } },
        gate.fail.status,
      )
    }
    const notifications = c.get('container').notifications
    if (!notifications) {
      throw new UnavailableError('Notifications are not configured')
    }
    const open = await notifications.service.listOpen(gate.auth.workspaceId)
    return c.json({ notifications: open }, 200)
  })

  // Act on a notification: run its typed side-effect (merge the PR / retry the run) exactly
  // once behind the service's atomic open→acted claim, then return the settled card. It can
  // perform a REAL GitHub merge, so it sits at the top of the scope ladder (`admin`) — the
  // same bar as task deletion. Headless: the merge runs under no `usr_*` initiator (the
  // deployment installation token), and — mirroring the retry route — an `act` that would
  // RETRY a run on an individual-usage model is refused up front, since a headless key has
  // no personal-credential unlock (`ci_failed`/`test_failed` are the only side-effects that
  // resume LLM work; the merge tails need no personal credential).
  buildHonoRoute(app, actPublicNotificationContract, async (c) => {
    const gate = await authorize(c, 'admin')
    if ('fail' in gate) {
      return c.json(
        { error: { code: gate.fail.code, message: gate.fail.message } },
        gate.fail.status,
      )
    }
    const { auth } = gate
    const container = c.get('container')
    const notifications = container.notifications
    if (!notifications) {
      throw new UnavailableError('Notifications are not configured')
    }
    const { id } = c.req.valid('param')
    const existing = await notifications.service.get(auth.workspaceId, id)
    if (!existing) {
      return c.json({ error: { code: 'not_found', message: 'Notification not found' } }, 404)
    }
    // Only the types with an AUTOMATED side-effect (merge / retry) are actionable headlessly.
    // Every other type parks a run on an interactive human decision — `act`-ing it would just
    // mark the card read while leaving the run parked, silently losing the reminder for a
    // still-pending decision. Refuse it and steer the caller to `dismiss` instead. (Skipped for
    // an already-resolved card, which `service.act` returns idempotently.)
    if (existing.status === 'open' && !HEADLESS_ACTIONABLE_NOTIFICATION_TYPES.has(existing.type)) {
      return c.json(
        {
          error: {
            code: 'notification_not_actionable',
            message:
              'This notification has no automated action; it parks a run on an interactive human decision. Resolve it in the app, or dismiss the card through the API.',
          },
        },
        409,
      )
    }
    // A ci-/test-failure card's `act` retries the run — resuming LLM work. Refuse it when the
    // run resolves to an individual-usage model (the same `personalGateForRun` primitive the
    // retry route uses). A no-op for a poolable model, and skipped entirely for a card whose
    // side-effect is a merge (no personal credential needed) or that is already resolved.
    if (
      existing.status === 'open' &&
      (existing.type === 'ci_failed' || existing.type === 'test_failed') &&
      existing.executionId
    ) {
      try {
        await personalGateForRun(
          container,
          auth.workspaceId,
          existing.executionId,
          undefined,
          undefined,
        )
      } catch (err) {
        if (err instanceof CredentialRequiredError) {
          return c.json(
            {
              error: {
                code: 'individual_model_unsupported',
                message:
                  'This notification retries a run on an individual-usage model that needs an interactive personal-credential unlock; it cannot be acted on through the API',
              },
            },
            409,
          )
        }
        throw err
      }
    }
    const acted = await notifications.service.act(
      auth.workspaceId,
      id,
      notificationActEffect(container, auth.workspaceId, null),
    )
    return c.json(acted, 200)
  })

  // Dismiss a notification without acting on it (waves the card off). Mutates state but has
  // no external side-effect, so it needs `write` (not `admin`). `resolve` is idempotent and
  // workspace-scoped: an unknown/foreign id throws NotFound → 404 via the shared handler.
  buildHonoRoute(app, dismissPublicNotificationContract, async (c) => {
    const gate = await authorize(c, 'write')
    if ('fail' in gate) {
      return c.json(
        { error: { code: gate.fail.code, message: gate.fail.message } },
        gate.fail.status,
      )
    }
    const notifications = c.get('container').notifications
    if (!notifications) {
      throw new UnavailableError('Notifications are not configured')
    }
    const resolved = await notifications.service.resolve(
      gate.auth.workspaceId,
      c.req.valid('param').id,
      'dismiss',
    )
    return c.json(resolved, 200)
  })
}
