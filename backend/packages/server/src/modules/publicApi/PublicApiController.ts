import {
  type Block,
  createInitiativeJobContract,
  createPublicTaskContract,
  getPublicJobContract,
  getPublicRunContract,
  getPublicTaskContract,
  listPublicPipelinesContract,
  listPublicServiceTasksContract,
  listPublicServicesContract,
  retryPublicTaskContract,
  startPublicTaskContract,
  stopPublicTaskContract,
  updatePublicTaskContract,
  type ExecutionInstance,
  type ExecutionStatus,
  type PublicJob,
  type PublicJobStatus,
  type PublicPipeline,
  type PublicRun,
  type PublicService,
  type PublicTask,
} from '@cat-factory/contracts'
import {
  type AgentKindRegistry,
  ARCHITECTURE_BRAINSTORM_AGENT_KIND,
  CLARITY_REVIEW_AGENT_KIND,
  isInlineModelStep,
  REQUIREMENTS_BRAINSTORM_AGENT_KIND,
  REQUIREMENTS_REVIEW_AGENT_KIND,
} from '@cat-factory/agents'
import { CredentialRequiredError } from '@cat-factory/kernel'
import type { PublicApiKeyAuth } from '@cat-factory/integrations'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import { personalGateForBlock, personalGateForRun } from '../providers/personalCredentialGate.js'
import type { AppEnv } from '../../http/env.js'

// The PUBLIC external API (`/api/v1/*`). Unlike the SPA surface it is NOT behind the user-session
// gate (its `/api` prefix is in the authGate bypass list); every route authenticates IN-CONTROLLER
// by a public-API key (`Authorization: Bearer cf_live_…`) resolved to a workspace scope, mirroring
// how `/internal` self-authenticates with a machine token. First use-case: "break down an
// initiative" — start a public, inline pipeline headlessly and retrieve its DB-persisted result
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

/** Max headless "initiative" runs a single workspace may have in flight at once (a public-API
 *  concurrency backstop: bounds the LLM spend one — possibly leaked — key can drive). */
const MAX_ACTIVE_INITIATIVE_RUNS = 5

/**
 * Inline agent kinds that PARK a run on a human/gate decision. A public run is headless (no human
 * to answer), so a pipeline containing one would hang forever (its anchor stays `in_progress`,
 * permanently consuming a concurrency slot) — refuse it at admission. This MUST list every
 * inline-and-parking kind: the two review gates AND the two brainstorm dialogues (all four set the
 * run `blocked` awaiting a human, see ExecutionService.evaluateReview / the brainstorm gate).
 */
const PARKING_INLINE_KINDS = new Set<string>([
  REQUIREMENTS_REVIEW_AGENT_KIND,
  CLARITY_REVIEW_AGENT_KIND,
  REQUIREMENTS_BRAINSTORM_AGENT_KIND,
  ARCHITECTURE_BRAINSTORM_AGENT_KIND,
])

type KeyResult =
  | { auth: PublicApiKeyAuth }
  | { fail: { status: 401 | 503; code: string; message: string } }

/**
 * Resolve the caller's public-API key to a workspace scope, or a `fail` describing the error the
 * handler should emit (kept as data, not a `Response`, so the contract handlers stay typed).
 */
async function resolveKey<E extends AppEnv>(c: Context<E>): Promise<KeyResult> {
  const svc = c.get('container').publicApiKeys
  if (!svc) {
    return { fail: { status: 503, code: 'unavailable', message: 'Public API is not configured' } }
  }
  const raw = c.req.header('authorization')?.replace(/^Bearer\s+/i, '')
  const auth = await svc.authenticate(raw)
  if (!auth) {
    return { fail: { status: 401, code: 'unauthorized', message: 'Invalid or missing API key' } }
  }
  return { auth }
}

function mapStatus(status: ExecutionStatus): PublicJobStatus {
  return status === 'done' ? 'succeeded' : status === 'failed' ? 'failed' : 'running'
}

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
    // The run's own creation stamp (set at start); older runs fall back to the earliest step start.
    createdAt:
      execution.createdAt ?? execution.steps.find((s) => s.startedAt != null)?.startedAt ?? 0,
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
    executionId: block.executionId,
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
    createdAt:
      execution.createdAt ?? execution.steps.find((s) => s.startedAt != null)?.startedAt ?? 0,
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
 * `pipelineId` for `start` — `public` (initiative-startable) and `headlessStartable` (safe to
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
 * Whether a pipeline is safe to expose to an EXTERNAL, headless caller: every enabled step runs
 * inline (no container, no repo, no push) AND none of them can park the run on a human decision
 * (an approval gate, or a review kind that waits for input). A public run has no human to answer,
 * so a parking step would hang until the SSE/timeout cap — reject it up front instead.
 */
function isHeadlessInlinePipeline(
  pipeline: {
    agentKinds: string[]
    enabled?: boolean[]
    gates?: boolean[]
  },
  registry: AgentKindRegistry,
): boolean {
  const enabled = pipeline.agentKinds
    .map((kind, i) => ({ kind, i }))
    .filter(({ i }) => pipeline.enabled?.[i] !== false)
  if (enabled.length === 0) return false
  // An approval gate on any enabled step parks the run for a human decision.
  if (enabled.some(({ i }) => pipeline.gates?.[i])) return false
  return enabled.every(
    ({ kind }) => isInlineModelStep(kind, registry) && !PARKING_INLINE_KINDS.has(kind),
  )
}

/**
 * Load a public JOB by id for an authenticated key: the persisted execution, but ONLY when it is
 * anchored on a HEADLESS internal block (a run this public surface created). Returns null when no
 * such run exists in the key's workspace OR the id points at a normal board execution — so an
 * external key can never read an arbitrary in-workspace run's output, only its own initiative jobs.
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
 * Best-effort, event-free rollback of a headless initiative run: drop the persisted run (the
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
  await container.executionRepository.deleteByBlock(workspaceId, blockId).catch(() => {})
  await container.boardService.deleteInternalTask(workspaceId, blockId).catch(() => {})
}

export function publicApiController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // Start an initiative run: validate the pipeline is public + inline, create a headless internal
  // block to anchor the run, and start it. Returns 202 with the job id + follow-up links.
  buildHonoRoute(app, createInitiativeJobContract, async (c) => {
    const gate = await resolveKey(c)
    if ('fail' in gate) {
      return c.json(
        { error: { code: gate.fail.code, message: gate.fail.message } },
        gate.fail.status,
      )
    }
    const { auth } = gate
    const container = c.get('container')
    const { pipelineId, input, title } = c.req.valid('json')

    const pipeline = (await container.pipelineService.list(auth.workspaceId)).find(
      (p) => p.id === pipelineId,
    )
    if (!pipeline || !pipeline.public) {
      return c.json(
        { error: { code: 'pipeline_not_public', message: 'Unknown or non-public pipeline' } },
        400,
      )
    }
    if (!isHeadlessInlinePipeline(pipeline, container.agentKindRegistry)) {
      // Defense in depth: a public pipeline must be inline-only (so an external run can never
      // trigger a container/GitHub push) AND non-parking (no human gate to hang a headless run).
      // The built-in public pipeline already satisfies both.
      return c.json(
        { error: { code: 'pipeline_not_inline', message: 'Public pipeline must be inline' } },
        400,
      )
    }

    // Concurrency backstop: cap the workspace's in-flight external runs so a leaked/abusive key
    // can't spin up unbounded LLM work. Counted in SQL, checked before the run is created.
    const active = await container.boardService.countActiveInternalTasks(auth.workspaceId)
    if (active >= MAX_ACTIVE_INITIATIVE_RUNS) {
      return c.json(
        {
          error: {
            code: 'too_many_active_runs',
            message: `This workspace already has ${MAX_ACTIVE_INITIATIVE_RUNS} initiative runs in flight; wait for one to finish`,
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
      execution = await container.executionService.start(
        auth.workspaceId,
        block.id,
        pipelineId,
        null,
      )
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
    if (activeNow > MAX_ACTIVE_INITIATIVE_RUNS) {
      await rollbackInitiativeRun(c, auth.workspaceId, block.id)
      return c.json(
        {
          error: {
            code: 'too_many_active_runs',
            message: `This workspace already has ${MAX_ACTIVE_INITIATIVE_RUNS} initiative runs in flight; wait for one to finish`,
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

  // Poll a job's status + result. Scoped to the key's workspace AND to headless initiative runs
  // (see loadPublicJob), so a job in another workspace — or a normal board run — is a 404.
  buildHonoRoute(app, getPublicJobContract, async (c) => {
    const gate = await resolveKey(c)
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

  // Stream a job's progress + terminal completion over SSE. Implemented as a bounded poll over the
  // persisted execution (runtime-symmetric by construction — no per-facade event-hub wiring), so
  // it serves identically on the Worker and Node. Authenticated by the API key header (an external
  // client can set headers, unlike a browser EventSource). Not a JSON contract, so a raw route.
  app.get('/api/v1/jobs/:id/events', async (c) => {
    const gate = await resolveKey(c)
    if ('fail' in gate) {
      return c.json(
        { error: { code: gate.fail.code, message: gate.fail.message } },
        gate.fail.status,
      )
    }
    const { auth } = gate
    const id = c.req.param('id')
    const container = c.get('container')
    // Same headless-job scoping as the poll read: only an initiative run this surface created.
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
      // timeout. The run was validated as headless-inline at admission, so it never parks — but
      // stop on ANY non-running raw status (blocked/paused too) rather than spinning to the cap.
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
        // A `paused` run is NOT terminal — the spend gate pauses a run when the workspace budget
        // is exhausted and RESUMES it once budget frees up (ExecutionService.evaluateStep), so keep
        // polling (bounded by SSE_MAX_MS below) rather than signalling a false terminal stop.
        if (execution.status !== 'running' && execution.status !== 'paused') {
          // The run has stopped. When it ended in a terminal public status (succeeded/failed) the
          // event above already carried `done`/`error`. But a raw status that maps to `running`
          // (e.g. `blocked` — a run parked awaiting a human, which a headless run can never resolve;
          // admission rules this out for the built-in pipeline) would otherwise close the stream
          // after a `progress` frame, leaving the client unable to tell "terminal" from "connection
          // dropped". Emit an explicit terminal `stopped` frame so every close is unambiguous.
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

  // --- Basic board workloads: services + tasks -------------------------------
  // The external counterparts of the SPA's board operations, scoped to the key's workspace
  // via `resolveKey`. Reads project a `Block` onto the small `publicTask`/`publicService`
  // resources (never the raw block). `start` runs a task's pipeline headlessly (no human in
  // the loop): it refuses an individual-usage-model task, which needs a personal-credential
  // unlock only an interactive user can supply.

  // List the workspace's services (board service frames).
  buildHonoRoute(app, listPublicServicesContract, async (c) => {
    const gate = await resolveKey(c)
    if ('fail' in gate) {
      return c.json(
        { error: { code: gate.fail.code, message: gate.fail.message } },
        gate.fail.status,
      )
    }
    const services = await c.get('container').boardService.listServices(gate.auth.workspaceId)
    return c.json({ services: services.map(toPublicService) }, 200)
  })

  // Create a task under a service.
  buildHonoRoute(app, createPublicTaskContract, async (c) => {
    const gate = await resolveKey(c)
    if ('fail' in gate) {
      return c.json(
        { error: { code: gate.fail.code, message: gate.fail.message } },
        gate.fail.status,
      )
    }
    const { serviceId } = c.req.valid('param')
    const block = await c
      .get('container')
      .boardService.addServiceTask(gate.auth.workspaceId, serviceId, c.req.valid('json'))
    return c.json(toPublicTask(block, serviceId), 201)
  })

  // List a service's tasks (whole subtree, headless anchors excluded).
  buildHonoRoute(app, listPublicServiceTasksContract, async (c) => {
    const gate = await resolveKey(c)
    if ('fail' in gate) {
      return c.json(
        { error: { code: gate.fail.code, message: gate.fail.message } },
        gate.fail.status,
      )
    }
    const { serviceId } = c.req.valid('param')
    const tasks = await c
      .get('container')
      .boardService.listServiceTasks(gate.auth.workspaceId, serviceId)
    if (!tasks) {
      return c.json({ error: { code: 'not_found', message: 'Service not found' } }, 404)
    }
    return c.json({ tasks: tasks.map((t) => toPublicTask(t, serviceId)) }, 200)
  })

  // Get a task's status.
  buildHonoRoute(app, getPublicTaskContract, async (c) => {
    const gate = await resolveKey(c)
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
    const gate = await resolveKey(c)
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
    // abuse backstop for board starts — the analogue of the initiative surface's active-run cap.
    await container.executionService.start(auth.workspaceId, taskId, pipelineId, null)
    // Re-read the task so the caller gets its AUTHORITATIVE post-start projection (status,
    // executionId, progress) rather than an optimistic guess — a run may park/block at its first
    // step rather than land on `in_progress`. `getServiceTask` never returns null here (start did
    // not delete the block), but fall back to the pre-start projection if the row is somehow gone.
    const after = await container.boardService.getServiceTask(auth.workspaceId, taskId)
    const projected = after ?? found
    return c.json(toPublicTask(projected.block, projected.service.id), 202)
  })

  // --- Task lifecycle: edit / stop / retry / run projection / live stream -----
  // The external counterparts of the SPA's task-lifecycle operations, each double-scoped
  // to the key's workspace AND to a real board task (`getServiceTask`, which excludes
  // headless anchors) — so an external key can never edit/stop/retry/read an arbitrary
  // in-workspace run. Each delegates to the SAME service method the SPA uses; no new logic.

  // Edit a task's title/description. Intended for pre-start authoring, but — like the SPA's
  // inline edit and the underlying `updateBlock` — it is NOT restricted to the pre-start
  // window; editing a running/finished task's title/description does not re-drive the run.
  buildHonoRoute(app, updatePublicTaskContract, async (c) => {
    const gate = await resolveKey(c)
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
    const gate = await resolveKey(c)
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

  // Retry a task's failed run. Mirrors the initiative/start refusals: a headless key has no
  // user/password to unlock an individual-usage (personal) subscription, so refuse a run
  // whose model resolves to such a vendor up front (→ 409). Uses `personalGateForRun` (the
  // same primitive the SPA retry path uses): it resolves the individual vendors from the
  // run's STORED steps — what the retry actually re-drives — rather than re-deriving them
  // from the current pipeline definition (which may have drifted), matching how
  // `ExecutionService.retry` validates. The engine's `retry` then throws `run_not_retryable`
  // (→ 409) unless the run actually failed.
  buildHonoRoute(app, retryPublicTaskContract, async (c) => {
    const gate = await resolveKey(c)
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
    const gate = await resolveKey(c)
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

  // Stream a task's run over SSE: the same bounded-poll pattern as the jobs stream (runtime-
  // symmetric by construction — no per-facade event-hub wiring), re-reading the persisted run
  // + its block each tick so a mid-run PR-open surfaces. Terminal on `done`/`failed`; a parked
  // `blocked`/`paused` keeps polling until the run resumes or the connection hits SSE_MAX_MS.
  app.get('/api/v1/tasks/:taskId/events', async (c) => {
    const gate = await resolveKey(c)
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
        if (execution.status === 'done' || execution.status === 'failed') break
        if (Date.now() - startedAt > SSE_MAX_MS) {
          await stream.writeSSE({ event: 'timeout', data: '{}' })
          break
        }
        await stream.sleep(SSE_POLL_MS)
      }
    })
  })

  // --- Pipeline discovery ----------------------------------------------------
  // List the workspace's pipelines so a caller can discover a valid `pipelineId` for `start`
  // (closing the `pipeline_required`-with-no-way-to-discover gap) and whether each is safe to
  // run headlessly. Archived pipelines are hidden.
  buildHonoRoute(app, listPublicPipelinesContract, async (c) => {
    const gate = await resolveKey(c)
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

  return app
}
