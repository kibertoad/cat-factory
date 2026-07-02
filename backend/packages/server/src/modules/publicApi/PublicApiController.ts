import {
  createInitiativeContract,
  getPublicJobContract,
  type ExecutionInstance,
  type ExecutionStatus,
  type PublicJob,
  type PublicJobStatus,
} from '@cat-factory/contracts'
import { isInlineModelStep } from '@cat-factory/agents'
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
    // No dedicated createdAt on the run; the earliest step's start is the effective creation time.
    createdAt: execution.steps.find((s) => s.startedAt != null)?.startedAt ?? 0,
    result,
    error,
  }
}

/** Whether every ENABLED step of a pipeline runs inline (no container, no repo, no push). */
function isInlinePipeline(pipeline: { agentKinds: string[]; enabled?: boolean[] }): boolean {
  const kinds = pipeline.agentKinds.filter((_, i) => pipeline.enabled?.[i] !== false)
  return kinds.length > 0 && kinds.every((kind) => isInlineModelStep(kind))
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
    if (!isInlinePipeline(pipeline)) {
      // Defense in depth: a public pipeline must be inline-only so an external run can never
      // trigger a container/GitHub push. (The built-in public pipeline already is.)
      return c.json(
        { error: { code: 'pipeline_not_inline', message: 'Public pipeline must be inline' } },
        400,
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

  // Poll a job's status + result. Workspace-scoped read, so a job in another workspace is a 404
  // (existence is not leaked across workspaces).
  buildHonoRoute(app, getPublicJobContract, async (c) => {
    const gate = await resolveKey(c)
    if ('fail' in gate) {
      return c.json(
        { error: { code: gate.fail.code, message: gate.fail.message } },
        gate.fail.status,
      )
    }
    const execution = await c
      .get('container')
      .executionRepository.get(gate.auth.workspaceId, c.req.valid('param').id)
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
    const initial = await container.executionRepository.get(auth.workspaceId, id)
    if (!initial) {
      return c.json({ error: { code: 'not_found', message: 'Job not found' } }, 404)
    }
    return streamSSE(c, async (stream) => {
      const startedAt = Date.now()
      let last = ''
      // Emit the initial state immediately, then poll until terminal / client-gone / timeout.
      for (;;) {
        if (stream.aborted) break
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
        if (job.status !== 'running') break
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
