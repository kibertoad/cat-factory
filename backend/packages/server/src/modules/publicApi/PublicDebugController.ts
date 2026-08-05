import {
  getDebugAgentContextContract,
  getDebugLlmCallContract,
  getDebugRunContract,
  listDebugAgentContextContract,
  listDebugLlmCallsContract,
  listDebugLogsContract,
  listDebugRunsContract,
  listDebugSearchQueriesContract,
  listDebugToolCallsContract,
} from '@cat-factory/contracts'
import type { DebugCursor, DebugPage, RunDebugService } from '@cat-factory/orchestration'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { authorize, refuse } from './publicApiAuth.js'
import { decodeTimeCursor, encodeCursor } from './publicApiPaging.js'

// The REMOTE DEBUGGING surface (`/api/v1/debug/*`) — the telemetry + provisioning-log reads an
// external operator needs to answer "why did this run fail / stall / cost that much". The
// intended caller is an LLM: everything the SPA's observability drill-down shows was already
// captured, but only reachable from a browser session, so an agent asked to diagnose a run had
// nothing to read. The wire shapes and the size discipline behind them are documented on the
// contracts (`@cat-factory/contracts` `debug-api.ts`); `backend/docs/debug-api.md` is the
// operator-facing guide.
//
// Three rules shape this controller specifically:
//
//  1. **`read` scope, deliberately not `admin`.** On this API `admin` also merges pull requests
//     and deletes tasks, so gating a read-only diagnostic surface behind it would mean handing a
//     debugging agent a destructive key — strictly worse than the exposure it was meant to
//     prevent. What model TEXT is retained at all remains governed where it is captured
//     (`LLM_RECORD_PROMPTS` + the per-workspace `storeAgentContext`), not here.
//  2. **Workspace scope, not the task-surface scope.** Unlike `PublicDecisionController`'s
//     `loadScopedRun` — which narrows to runs this key could already reach through
//     `GET /jobs/:id` / `GET /tasks/:taskId/run` — a run here is in scope if it belongs to the
//     key's workspace. That is wider ON PURPOSE: a service frame's blueprint run and a recurring
//     bug-intake fire are exactly the runs someone asks about, and a debugger that cannot see the
//     run that failed is useless. The key is already workspace-scoped, so nothing outside the
//     caller's own board becomes reachable.
//  3. **No handler owns a bound.** Every limit, body budget and cursor is validated by the
//     contract schema and applied by the service against SQL; a handler that clamped its own
//     numbers would be a second, drifting copy of the guarantee the contract already makes.

/** Page sizes when a request passes no `?limit=`. The hard ceiling lives in the query contract. */
const DEFAULT_RUN_PAGE = 25
const DEFAULT_CALL_PAGE = 25
const DEFAULT_CONTEXT_PAGE = 25
const DEFAULT_SMALL_ROW_PAGE = 50

/**
 * The per-body budget a point read uses when the caller names none: the whole stored body, up
 * to the contract's ceiling. A point read is an explicit drill-down into ONE row, so defaulting
 * it to a preview would make the endpoint that exists to return bodies return none.
 */
const DEFAULT_POINT_READ_BODY_CHARS = 200_000

/** Resolve the debug reader, or the 503 to emit. Absent only on a facade that wired no engine. */
function requireDebug<E extends AppEnv>(c: Context<E>): RunDebugService | null {
  return c.get('container').runDebug ?? null
}

const unavailable = <E extends AppEnv>(c: Context<E>) =>
  c.json({ error: { code: 'unavailable', message: 'Run debugging is not configured' } }, 503)

const notFound = <E extends AppEnv>(c: Context<E>, what: string) =>
  c.json({ error: { code: 'not_found', message: `No such ${what}` } }, 404)

/**
 * Decode an opaque wire cursor into a keyset position.
 *
 * A malformed cursor is a 400, NEVER a silent fall back to page 1: a client paging on a
 * corrupted cursor would otherwise re-serve the first page forever with no error to act on —
 * which for an autonomous caller is an infinite loop rather than a visible failure.
 */
function readCursor(raw: string | undefined): { cursor?: DebugCursor } | { invalid: true } {
  if (!raw) return {}
  const decoded = decodeTimeCursor(raw)
  return decoded ? { cursor: decoded } : { invalid: true }
}

const invalidCursor = <E extends AppEnv>(c: Context<E>) =>
  c.json({ error: { code: 'invalid_cursor', message: 'Malformed cursor' } }, 400)

/**
 * A cursor paired with `order=trajectory`: the ordered read is a bounded prefix and issues no
 * cursor, so there is nothing the position could have come from. REFUSED rather than ignored,
 * for the same reason a malformed cursor is: a caller that thinks it is paging and is silently
 * being re-served the same prefix has an infinite loop with no error to act on.
 */
const cursorNotPageable = <E extends AppEnv>(c: Context<E>) =>
  c.json(
    {
      error: {
        code: 'invalid_cursor',
        message: 'Trajectory order returns a bounded prefix and cannot be resumed with a cursor',
      },
    },
    400,
  )

/** Encode a service page's next position back onto the wire (null ⇒ that was the last page). */
function nextCursorOf<T>(page: DebugPage<T>): string | null {
  return page.nextCursor ? encodeCursor(page.nextCursor.createdAt, page.nextCursor.id) : null
}

export function publicDebugController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // The entry point for a caller that holds no run id: "which of my runs failed recently".
  buildHonoRoute(app, listDebugRunsContract, async (c) => {
    const gate = await authorize(c, 'read')
    if ('fail' in gate) return refuse(c, gate.fail)
    const debug = requireDebug(c)
    if (!debug) return unavailable(c)
    const query = c.req.valid('query')
    const cursor = readCursor(query.cursor)
    if ('invalid' in cursor) return invalidCursor(c)
    const page = await debug.listRuns(gate.auth.workspaceId, {
      limit: query.limit ?? DEFAULT_RUN_PAGE,
      cursor: cursor.cursor,
      status: query.status,
      since: query.since,
    })
    return c.json({ runs: page.items, nextCursor: nextCursorOf(page) }, 200)
  })

  // The run's diagnostic map — aggregates only, so this is the call a client always makes first.
  buildHonoRoute(app, getDebugRunContract, async (c) => {
    const gate = await authorize(c, 'read')
    if ('fail' in gate) return refuse(c, gate.fail)
    const debug = requireDebug(c)
    if (!debug) return unavailable(c)
    const workspaceId = gate.auth.workspaceId
    const execution = await debug.getRun(workspaceId, c.req.valid('param').runId)
    if (!execution) return notFound(c, 'run')
    return c.json(await debug.overview(workspaceId, execution), 200)
  })

  // The run's model calls. Bodies only when `bodyChars` asks for them, sliced in SQL.
  buildHonoRoute(app, listDebugLlmCallsContract, async (c) => {
    const gate = await authorize(c, 'read')
    if ('fail' in gate) return refuse(c, gate.fail)
    const debug = requireDebug(c)
    if (!debug) return unavailable(c)
    const workspaceId = gate.auth.workspaceId
    const runId = c.req.valid('param').runId
    const query = c.req.valid('query')
    const cursor = readCursor(query.cursor)
    if ('invalid' in cursor) return invalidCursor(c)
    // 404 on an unknown run rather than an empty page: a caller that mistyped a run id (or is
    // pointed at the wrong workspace) must not read "this run made no model calls". A PROBE,
    // not a `getRun`: the guard runs on every page and discards the run.
    if (!(await debug.runExists(workspaceId, runId))) return notFound(c, 'run')
    const page = await debug.listLlmCalls(workspaceId, runId, {
      limit: query.limit ?? DEFAULT_CALL_PAGE,
      cursor: cursor.cursor,
      agentKind: query.agentKind,
      phase: query.phase,
      outcome: query.outcome,
      order: query.order,
      bodyChars: query.bodyChars ?? 0,
      contains: query.contains,
    })
    return c.json({ calls: page.items, nextCursor: nextCursorOf(page) }, 200)
  })

  // One call's full (windowed) prompt delta, response and reasoning — raw, or parsed into
  // per-message rows via `?view=messages`.
  buildHonoRoute(app, getDebugLlmCallContract, async (c) => {
    const gate = await authorize(c, 'read')
    if ('fail' in gate) return refuse(c, gate.fail)
    const debug = requireDebug(c)
    if (!debug) return unavailable(c)
    const query = c.req.valid('query')
    const call = await debug.getLlmCall(gate.auth.workspaceId, c.req.valid('param').callId, {
      bodyChars: query.bodyChars ?? DEFAULT_POINT_READ_BODY_CHARS,
      bodyOffset: query.bodyOffset ?? 0,
      view: query.view ?? 'raw',
    })
    return call ? c.json(call, 200) : notFound(c, 'call')
  })

  // The run's captured dispatches — identity and sizes, never bodies.
  buildHonoRoute(app, listDebugAgentContextContract, async (c) => {
    const gate = await authorize(c, 'read')
    if ('fail' in gate) return refuse(c, gate.fail)
    const debug = requireDebug(c)
    if (!debug) return unavailable(c)
    const workspaceId = gate.auth.workspaceId
    const runId = c.req.valid('param').runId
    const query = c.req.valid('query')
    const cursor = readCursor(query.cursor)
    if ('invalid' in cursor) return invalidCursor(c)
    if (!(await debug.runExists(workspaceId, runId))) return notFound(c, 'run')
    const page = await debug.listAgentContext(workspaceId, runId, {
      limit: query.limit ?? DEFAULT_CONTEXT_PAGE,
      cursor: cursor.cursor,
      stepIndex: query.stepIndex,
    })
    return c.json({ snapshots: page.items, nextCursor: nextCursorOf(page) }, 200)
  })

  // One dispatch's prompts, folded fragments and injected files, each budgeted independently.
  buildHonoRoute(app, getDebugAgentContextContract, async (c) => {
    const gate = await authorize(c, 'read')
    if ('fail' in gate) return refuse(c, gate.fail)
    const debug = requireDebug(c)
    if (!debug) return unavailable(c)
    const query = c.req.valid('query')
    const snapshot = await debug.getAgentContext(
      gate.auth.workspaceId,
      c.req.valid('param').snapshotId,
      query.bodyChars ?? DEFAULT_POINT_READ_BODY_CHARS,
      query.bodyOffset ?? 0,
    )
    return snapshot ? c.json(snapshot, 200) : notFound(c, 'snapshot')
  })

  // The web searches the run's agents performed (small rows, returned whole).
  buildHonoRoute(app, listDebugSearchQueriesContract, async (c) => {
    const gate = await authorize(c, 'read')
    if ('fail' in gate) return refuse(c, gate.fail)
    const debug = requireDebug(c)
    if (!debug) return unavailable(c)
    const workspaceId = gate.auth.workspaceId
    const runId = c.req.valid('param').runId
    const query = c.req.valid('query')
    const cursor = readCursor(query.cursor)
    if ('invalid' in cursor) return invalidCursor(c)
    if (!(await debug.runExists(workspaceId, runId))) return notFound(c, 'run')
    const page = await debug.listSearchQueries(workspaceId, runId, {
      limit: query.limit ?? DEFAULT_SMALL_ROW_PAGE,
      cursor: cursor.cursor,
    })
    return c.json({ queries: page.items, nextCursor: nextCursorOf(page) }, 200)
  })

  // The tool calls the run's agents made. Rows come back whole (both bodies are capped at
  // capture, so the page size is computable before the request) with `bodies` saying whether
  // they were retained at all. Two orders: the keyset page every sibling list serves, and the
  // TRAJECTORY — what the agent did, in the order it did it, which is the read this sink
  // exists for and the one a client cannot correctly derive from the rows itself.
  buildHonoRoute(app, listDebugToolCallsContract, async (c) => {
    const gate = await authorize(c, 'read')
    if ('fail' in gate) return refuse(c, gate.fail)
    const debug = requireDebug(c)
    if (!debug) return unavailable(c)
    const workspaceId = gate.auth.workspaceId
    const runId = c.req.valid('param').runId
    const query = c.req.valid('query')
    const cursor = readCursor(query.cursor)
    if ('invalid' in cursor) return invalidCursor(c)
    if (query.order === 'trajectory' && cursor.cursor) return cursorNotPageable(c)
    if (!(await debug.runExists(workspaceId, runId))) return notFound(c, 'run')
    const page = await debug.listToolCalls(workspaceId, runId, {
      limit: query.limit ?? DEFAULT_SMALL_ROW_PAGE,
      ...(cursor.cursor ? { cursor: cursor.cursor } : {}),
      ...(query.jobId ? { jobId: query.jobId } : {}),
      ...(query.order ? { order: query.order } : {}),
      // `ok` is a string on the wire (a query param always is), so the enum is narrowed to the
      // boolean the port takes here rather than carried as text down to the SQL.
      ...(query.ok ? { ok: query.ok === 'true' } : {}),
    })
    return c.json({ toolCalls: page.items, nextCursor: nextCursorOf(page) }, 200)
  })

  // The run's provisioning event log: how its infrastructure came up, or why it didn't. For a
  // run whose container never started this is the ONLY record of the cause — it has no model
  // telemetry at all.
  buildHonoRoute(app, listDebugLogsContract, async (c) => {
    const gate = await authorize(c, 'read')
    if ('fail' in gate) return refuse(c, gate.fail)
    const debug = requireDebug(c)
    if (!debug) return unavailable(c)
    const workspaceId = gate.auth.workspaceId
    const runId = c.req.valid('param').runId
    const query = c.req.valid('query')
    const cursor = readCursor(query.cursor)
    if ('invalid' in cursor) return invalidCursor(c)
    if (!(await debug.runExists(workspaceId, runId))) return notFound(c, 'run')
    const page = await debug.listProvisioningLog(workspaceId, runId, {
      limit: query.limit ?? DEFAULT_SMALL_ROW_PAGE,
      cursor: cursor.cursor,
    })
    return c.json({ entries: page.items, nextCursor: nextCursorOf(page) }, 200)
  })

  return app
}
