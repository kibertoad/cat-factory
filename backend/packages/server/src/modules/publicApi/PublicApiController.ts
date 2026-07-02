import {
  createInitiativeContract,
  getPublicJobContract,
  type ExecutionInstance,
  type ExecutionStatus,
  type PublicJob,
  type PublicJobStatus,
} from '@cat-factory/contracts'
import {
  CLARITY_REVIEW_AGENT_KIND,
  isInlineModelStep,
  REQUIREMENTS_REVIEW_AGENT_KIND,
} from '@cat-factory/agents'
import type { PublicApiKeyAuth } from '@cat-factory/integrations'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { AppEnv } from '../../http/env.js'

// The PUBLIC external API (`/api/v1/*`). Unlike the SPA surface it is NOT behind the user-session
// gate (its `/api` prefix is in the authGate bypass list); every route authenticates IN-CONTROLLER
// by a public-API key (`Authorization: Bearer cf_live_…`) resolved to a workspace scope, mirroring
// how `/internal` self-authenticates with a machine token. First use-case: "break down an
// initiative" — start a public, inline pipeline headlessly and retrieve its DB-persisted result
// asynchronously (poll `GET /jobs/:id` or stream `GET /jobs/:id/events`). Nothing is pushed to
// GitHub: the pipeline is inline-only, so the run produces its output purely in the DB.

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
 * to answer), so a pipeline containing one would hang until it times out — refuse it at admission.
 */
const PARKING_INLINE_KINDS = new Set<string>([
  REQUIREMENTS_REVIEW_AGENT_KIND,
  CLARITY_REVIEW_AGENT_KIND,
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
export function toPublicJob(execution: ExecutionInstance): PublicJob {
  const status = mapStatus(execution.status)
  const terminal = execution.steps[execution.steps.length - 1]
  const result =
    status === 'succeeded' && terminal
      ? { output: terminal.output ?? '', data: terminal.custom ?? null }
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
    createdAt: execution.createdAt ?? execution.steps.find((s) => s.startedAt != null)?.startedAt ?? 0,
    result,
    error,
  }
}

/**
 * Whether a pipeline is safe to expose to an EXTERNAL, headless caller: every enabled step runs
 * inline (no container, no repo, no push) AND none of them can park the run on a human decision
 * (an approval gate, or a review kind that waits for input). A public run has no human to answer,
 * so a parking step would hang until the SSE/timeout cap — reject it up front instead.
 */
function isHeadlessInlinePipeline(pipeline: {
  agentKinds: string[]
  enabled?: boolean[]
  gates?: boolean[]
}): boolean {
  const enabled = pipeline.agentKinds
    .map((kind, i) => ({ kind, i }))
    .filter(({ i }) => pipeline.enabled?.[i] !== false)
  if (enabled.length === 0) return false
  // An approval gate on any enabled step parks the run for a human decision.
  if (enabled.some(({ i }) => pipeline.gates?.[i])) return false
  return enabled.every(({ kind }) => isInlineModelStep(kind) && !PARKING_INLINE_KINDS.has(kind))
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

export function publicApiController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // Start an initiative run: validate the pipeline is public + inline, create a headless internal
  // block to anchor the run, and start it. Returns 202 with the job id + follow-up links.
  buildHonoRoute(app, createInitiativeContract, async (c) => {
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
    if (!isHeadlessInlinePipeline(pipeline)) {
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
    // personal credential), so pass null rather than a synthetic user id.
    const execution = await container.executionService.start(
      auth.workspaceId,
      block.id,
      pipelineId,
      null,
    )
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
        if (execution.status !== 'running') break
        if (Date.now() - startedAt > SSE_MAX_MS) {
          // Bound the connection; the client can reconnect to keep watching.
          await stream.writeSSE({ event: 'timeout', data: '{}' })
          break
        }
        await stream.sleep(SSE_POLL_MS)
      }
    })
  })

  return app
}
