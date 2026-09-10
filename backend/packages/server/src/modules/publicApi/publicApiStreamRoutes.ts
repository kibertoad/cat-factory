import type { PublicDecisionList } from '@cat-factory/contracts'
import type { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { AppEnv } from '../../http/env.js'
import { projectDecisionList } from './decisions/projection.js'
import { loadScopedRun } from './decisions/scope.js'
import { authorize } from './publicApiAuth.js'
import {
  createDecisionAnnouncer,
  createParkAnnouncer,
  isParked,
  reduceDecisionsForStream,
  reduceRunForStream,
} from './publicApiStream.js'
import { loadPublicJob, toPublicJob, toPublicRun } from './runProjection.js'

// The public SSE routes: the two RUN streams (`GET /api/v1/jobs/:id/events` and
// `GET /api/v1/tasks/:taskId/events`) and the DECISION stream beside them
// (`GET /api/v1/runs/:runId/decision-events`).
//
// Both are BOUNDED POLLS over the persisted run rather than a subscription to an event hub, which
// is what makes them runtime-symmetric by construction: there is nothing per-facade to wire, so
// the Worker and Node serve the identical stream. Frames are de-duplicated on the serialized
// payload, so a quiet run produces a quiet stream.
//
// Neither is a JSON route contract (the response is `text/event-stream`), so both are raw Hono
// routes documented by hand in `scripts/generate-openapi.mjs`. Their `read` scope literal lives
// here and is restated there; keep the two in step.
//
// They live in their own module because they are the bulk of what `PublicApiController` used to
// be and they share the decision channel below, which neither of that controller's other route
// groups has anything to do with.

/** How often a stream re-reads the run, and the hard cap on how long the connection stays open. */
const SSE_POLL_MS = 1000
const SSE_MAX_MS = 5 * 60 * 1000
/** Re-verify the caller's key at most this often on a live stream, so a mid-stream revoke cuts it. */
const SSE_REAUTH_MS = 5000

/**
 * `GET /api/v1/runs/:runId/decision-events`: the run's whole `PublicDecisionList`, pushed as a
 * `decision-state` frame whenever it changes.
 *
 * This is what makes a chunked operation legible without polling. A run's progress lives on the
 * execution, but what a PR deep review or a bug-fishing expedition is DOING lives on state the run
 * projection does not carry (`step.prReview`, `step.bugFishing`): its own status, how many slices
 * have reported, a challenge verdict landing. None of that moves `publicRun`, so on the two run
 * streams beside this one a review emits no frame at all for its entire duration and then a single
 * `decision` at the park. The documentation told a caller to poll `/runs/:runId/decisions` for
 * exactly the progress those streams could not give it; this serves the same payload by push.
 *
 * ITS OWN ROUTE rather than a flag on the run streams, and the reason is the published SDKs rather
 * than taste. A query parameter added to an existing operation is emitted as a positional argument
 * ahead of the trailing options bag, so `stream(id, options)` becomes `stream(id, query, options)`
 * in TypeScript and `Stream(ctx, id)` grows an argument in Go: an in-place retype of four released
 * clients, which this surface does not do. A NEW operation is the additive shape, and it turns out
 * to be the better one anyway. It is keyed by RUN like the decision list it streams, so one route
 * serves a board task and a headless job where a flag needed adding to two; and the run streams
 * stay what they are, which is progress channels.
 *
 * `read` scope, matching `GET /api/v1/runs/:runId/decisions`: knowing what a run is waiting on is a
 * monitoring concern, and answering is what needs `decide`.
 */
export function registerRunDecisionStreamRoute(app: Hono<AppEnv>): void {
  app.get('/api/v1/runs/:runId/decision-events', async (c) => {
    const gate = await authorize(c, 'read')
    if ('fail' in gate) {
      return c.json(
        { error: { code: gate.fail.code, message: gate.fail.message } },
        gate.fail.status,
      )
    }
    const { auth } = gate
    const runId = c.req.param('runId')
    const container = c.get('container')
    // The same resolution the decision ROUTES use, so this streams exactly the population they
    // answer: a board task run or a headless job anchor in the key's workspace, and anything else
    // is a 404 indistinguishable from a run that never existed.
    const scoped = await loadScopedRun(c, auth.workspaceId, runId)
    if (!scoped) {
      return c.json({ error: { code: 'not_found', message: 'Run not found' } }, 404)
    }
    const { blockId } = scoped
    const keys = container.publicApiKeys
    return streamSSE(c, async (stream) => {
      const startedAt = Date.now()
      let lastAuthCheck = Date.now()
      // Change-detected on the serialized payload, like the progress frames on the run streams, so
      // a park that lasts an hour costs one frame rather than 3,600 identical ones.
      const changed = createDecisionAnnouncer()
      for (;;) {
        if (stream.aborted) break
        if (keys && Date.now() - lastAuthCheck > SSE_REAUTH_MS) {
          if (!(await keys.isActive(auth.keyId))) break
          lastAuthCheck = Date.now()
        }
        const execution = await container.executionRepository.get(auth.workspaceId, runId)
        if (!execution) break
        const list: PublicDecisionList = await projectDecisionList(
          c,
          auth.workspaceId,
          blockId,
          execution,
        )
        // Reduced for the same reason `reduceRunForStream` reduces beside it: the frame carries the
        // WHOLE list and is re-sent whenever any part of it moves, so a park holding eighty
        // model-authored findings would repeat all of them for the rest of the run. The list itself
        // is never narrowed: only the prose inside it is clipped, and `truncated` says so.
        const data = JSON.stringify(reduceDecisionsForStream(list))
        if (changed.shouldAnnounce(data)) {
          await stream.writeSSE({ event: 'decision-state', data })
        }
        // A finished run asks nothing, so the stream ends rather than holding a connection open
        // over a list that can no longer move. The LAST frame is written above first, which is what
        // makes the close readable: a caller sees the decisions empty out and then the terminal.
        if (execution.status === 'done' || execution.status === 'failed') {
          await stream.writeSSE({ event: 'done', data })
          break
        }
        if (Date.now() - startedAt > SSE_MAX_MS) {
          await stream.writeSSE({ event: 'timeout', data: '{}' })
          break
        }
        await stream.sleep(SSE_POLL_MS)
      }
    })
  })
}

export function registerJobStreamRoute(app: Hono<AppEnv>): void {
  // Stream a job's progress + terminal completion over SSE. Authenticated by the API key header
  // (an external client can set headers, unlike a browser `EventSource`).
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
      // timeout. A `blocked` run is a PARK awaiting a human decision, no longer a dead end, since
      // a `decide`-scope caller can answer it over `/api/v1/runs/:runId/decisions`, so the stream
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
        const job = toPublicJob(execution, auth.externalIdentity)
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
        // stream open: the park is answerable, and answering resumes the very run being watched,
        // which the caller should see through the SAME connection. Announced once per park rather
        // than every tick, so a long park doesn't spam identical frames; re-armed when the run
        // resumes, so a second park later in the pipeline is announced too.
        if (parks.shouldAnnounce(execution.status)) {
          await stream.writeSSE({ event: 'decision', data })
        }
        // A `paused` run is NOT terminal: the spend gate pauses a run when the workspace budget
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

export function registerTaskRunStreamRoute(app: Hono<AppEnv>): void {
  // Stream a task's run over SSE: the same bounded-poll pattern as the jobs stream, re-reading the
  // persisted run + its block each tick so a mid-run PR-open surfaces. Terminal on `done`/`failed`;
  // a parked `blocked`/`paused` keeps polling until the run resumes or the connection hits
  // SSE_MAX_MS.
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
        // Re-read the block for the current PR/branch: the run opens the PR mid-flight, so
        // the block (not the execution) carries it.
        const block = await container.boardService.getServiceTask(auth.workspaceId, taskId)
        if (!execution || !block) break
        // Reduced for the wire: the frame carries the whole run, so an oversized step deliverable
        // would be re-sent on every change for the rest of the run. See `reduceRunForStream`.
        const runView = reduceRunForStream(
          toPublicRun(execution, block.block, auth.externalIdentity),
        )
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
        // is actually being asked. The stream stays open across the park: answering resumes this
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
