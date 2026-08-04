import { Hono } from 'hono'
import * as v from 'valibot'
import {
  agentContextSnapshotSchema,
  agentSearchQuerySchema,
  agentToolCallSchema,
  llmCallMetricSchema,
} from '@cat-factory/contracts'
import type {
  AgentContextSnapshot,
  AgentSearchQuery,
  AgentToolCall,
  LlmCallMetric,
} from '@cat-factory/kernel'
import { verifyMachineRequest } from '../../auth/machineGate.js'
import type { AppEnv } from '../../http/env.js'
import { logger } from '../../observability/logger.js'
import {
  MAX_TELEMETRY_INGEST_CHARS,
  TELEMETRY_INGEST_LIMITS,
  type TelemetryIngestRequest,
} from '../../telemetry/machineTelemetry.js'

/**
 * The mothership-mode telemetry INGEST machine API: `POST /internal/telemetry/ingest`.
 *
 * A mothership-mode local node captures its run telemetry LOCALLY (product decision 5) — routing
 * per-call rows through the persistence RPC would put a network round trip on the hot path of
 * every model call. The consequence, until this endpoint, was that those rows never left the
 * laptop: a hosted teammate opening a run a developer drove saw an empty observability panel,
 * zero token rollups and no web-search log, and the rows vanished for good when the node's short
 * retention window came round. This is the sync UP — the node uploads a QUIESCED run's captured
 * rows in bounded batches, and the mothership appends them to its own telemetry store.
 *
 * Security mirrors the persistence RPC and the notification relay: gated NOT by the user-session
 * `authGate` (its `/internal` prefix is bypassed) but by a `machine`-audience token, checked FIRST
 * so the endpoint is not probeable without one, then account-scoped — the batch's `workspaceId` is
 * resolved to its owning account and anything outside the token's scope is a uniform 404.
 *
 * Two properties do the rest of the work:
 *
 * - **The batch's scope is STAMPED onto every row.** Whatever `workspaceId` / `executionId` the
 *   rows themselves carry is discarded and replaced with the scope-bound pair from the envelope.
 *   So a node can neither file telemetry into a workspace it cannot already reach, nor smuggle a
 *   foreign run's rows in through an in-scope workspace.
 * - **The append is idempotent by row id** (the ports' `recordMany`), which is what lets the node
 *   retry a chunk whose ack was lost. A repeat is ignored rather than overwritten — overwriting
 *   would invalidate a metric's stored prompt DELTA, which is only meaningful against the chain
 *   tip that preceded its first write.
 *
 * Deliberately its own endpoint rather than allow-listed persistence-RPC methods: the whole reason
 * telemetry is local-first is that its writes must not be per-row RPCs, so re-admitting them one
 * at a time would undo the bucket (ADR 0009 — cross-cutting concerns get their own `/internal/*`
 * surface). Mounted on BOTH facades so either a Node or a Cloudflare deployment can be a
 * mothership. A facade that is not a mothership (no `repositories`) serves a 503.
 * See docs/initiatives/mothership-mode.md.
 */
export function telemetryIngestController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.post('/internal/telemetry/ingest', async (c) => {
    const container = c.get('container')

    // Auth first (before the seam probe) — a token-less caller can't tell a mothership from a
    // non-mothership facade.
    const payload = await verifyMachineRequest(c)
    if (!payload) {
      return c.json(
        { ok: false, error: { code: 'forbidden', message: 'invalid machine token' } },
        403,
      )
    }

    const repos = container.repositories
    const workspaceRepository = repos?.workspaceRepository
    const metricRepository = repos?.llmCallMetricRepository
    const snapshotRepository = repos?.agentContextSnapshotRepository
    const searchRepository = repos?.agentSearchQueryRepository
    const toolCallRepository = repos?.agentToolCallRepository
    if (
      typeof workspaceRepository?.accountOf !== 'function' ||
      typeof metricRepository?.recordMany !== 'function' ||
      typeof snapshotRepository?.recordMany !== 'function' ||
      typeof searchRepository?.recordMany !== 'function' ||
      typeof toolCallRepository?.recordMany !== 'function'
    ) {
      return c.json(
        { ok: false, error: { code: 'internal', message: 'telemetry ingest not enabled' } },
        503,
      )
    }

    // Size backstop, in two steps, because the row caps below bound COUNT while a single
    // pathological snapshot moves BYTES.
    //
    // The DECLARED length is checked first, before the body is read at all: `c.req.text()` buffers
    // the entire request into memory, so a check after it protects the parsed object graph but not
    // the string it parses from — a compromised node token could still make the mothership hold an
    // arbitrarily large body. Refusing on the header also spares the node an upload it was always
    // going to have refused.
    const declared = Number(c.req.header('content-length'))
    if (Number.isFinite(declared) && declared > MAX_TELEMETRY_INGEST_CHARS) {
      return c.json({ ok: false, error: { code: 'validation', message: 'batch too large' } }, 413)
    }
    // Then the ACTUAL length, since `content-length` is absent on a chunked upload and is in any
    // case the client's claim about itself rather than a fact.
    const raw = await c.req.text()
    if (raw.length > MAX_TELEMETRY_INGEST_CHARS) {
      return c.json({ ok: false, error: { code: 'validation', message: 'batch too large' } }, 413)
    }
    let body: TelemetryIngestRequest
    try {
      body = JSON.parse(raw) as TelemetryIngestRequest
    } catch {
      return c.json(
        { ok: false, error: { code: 'validation', message: 'invalid request body' } },
        422,
      )
    }
    if (!body || typeof body.workspaceId !== 'string' || typeof body.executionId !== 'string') {
      return c.json(
        {
          ok: false,
          error: { code: 'validation', message: 'workspaceId and executionId are required' },
        },
        422,
      )
    }

    const log = logger.child({
      scope: 'telemetryIngest',
      nodeId: payload.nodeId,
      userId: payload.userId,
    })

    // Account-scope binding: resolve the batch's workspace to its owning account and refuse
    // anything outside the token's scope as 404 (no existence leak), matching the persistence RPC.
    const accountId = (await (
      workspaceRepository.accountOf(body.workspaceId) as Promise<string | null | undefined>
    ).catch(() => undefined)) as string | null | undefined
    if (!accountId || !payload.scope.accountIds.includes(accountId)) {
      log.warn('telemetry ingest: workspace out of scope', { workspaceId: body.workspaceId })
      return c.json({ ok: false, error: { code: 'not_found', message: 'Not found' } }, 404)
    }

    const oversized = overCap(body)
    if (oversized) {
      // Refused, never truncated: a silently shortened batch would leave the node marking the run
      // as fully ingested with rows the mothership never stored.
      return c.json(
        { ok: false, error: { code: 'validation', message: `too many ${oversized} rows` } },
        413,
      )
    }

    const rows = decodeRows(body)
    if (!rows) {
      return c.json(
        { ok: false, error: { code: 'validation', message: 'invalid telemetry rows' } },
        422,
      )
    }

    // Stamp the SCOPE onto every row (see the controller note) — the rows' own ids are the only
    // thing about them the node gets to choose.
    const scope = { workspaceId: body.workspaceId, executionId: body.executionId }
    try {
      // The reflected registry is structurally typed (repo name → method), so each call is cast
      // back to its port signature at the boundary, exactly like the persistence RPC's dispatch.
      await (metricRepository.recordMany(
        rows.metrics.map((m) => ({ ...m, ...scope })),
      ) as Promise<void>)
      await (snapshotRepository.recordMany(
        rows.snapshots.map((s) => ({ ...s, ...scope })),
      ) as Promise<void>)
      await (searchRepository.recordMany(
        rows.searchQueries.map((q) => ({ ...q, ...scope })),
      ) as Promise<void>)
      await (toolCallRepository.recordMany(
        rows.toolCalls.map((t) => ({ ...t, ...scope })),
      ) as Promise<void>)
    } catch (error) {
      // A failed append must be visible to the node: it leaves the run's high-water mark alone
      // and retries next sweep, which is exactly right because the append is idempotent.
      log.error('telemetry ingest: append failed', {
        workspaceId: body.workspaceId,
        executionId: body.executionId,
        err: error instanceof Error ? error.message : String(error),
      })
      return c.json({ ok: false, error: { code: 'internal', message: 'Internal error' } }, 500)
    }

    return c.json({
      ok: true,
      stored: {
        metrics: rows.metrics.length,
        snapshots: rows.snapshots.length,
        searchQueries: rows.searchQueries.length,
        toolCalls: rows.toolCalls.length,
      },
    })
  })

  return app
}

/** The first sink whose row count exceeds its per-request cap, or null when all are within it. */
function overCap(body: TelemetryIngestRequest): keyof typeof TELEMETRY_INGEST_LIMITS | null {
  if ((body.metrics?.length ?? 0) > TELEMETRY_INGEST_LIMITS.metrics) return 'metrics'
  if ((body.snapshots?.length ?? 0) > TELEMETRY_INGEST_LIMITS.snapshots) return 'snapshots'
  if ((body.searchQueries?.length ?? 0) > TELEMETRY_INGEST_LIMITS.searchQueries) {
    return 'searchQueries'
  }
  if ((body.toolCalls?.length ?? 0) > TELEMETRY_INGEST_LIMITS.toolCalls) return 'toolCalls'
  return null
}

const metricsSchema = v.optional(v.array(llmCallMetricSchema), [])
const snapshotsSchema = v.optional(v.array(agentContextSnapshotSchema), [])
const searchQueriesSchema = v.optional(v.array(agentSearchQuerySchema), [])
const toolCallsSchema = v.optional(v.array(agentToolCallSchema), [])

interface DecodedRows {
  metrics: LlmCallMetric[]
  snapshots: AgentContextSnapshot[]
  searchQueries: AgentSearchQuery[]
  toolCalls: AgentToolCall[]
}

/**
 * Validate each sink's rows against the SAME wire schema the rest of the product reads them
 * through, or null when any row is out of contract. Whole-batch rejection rather than
 * drop-the-bad-row: the node treats a 2xx as "this range is stored" and moves its high-water mark
 * past it, so a partially accepted batch would lose rows with nothing left to notice it.
 */
function decodeRows(body: TelemetryIngestRequest): DecodedRows | null {
  const metrics = v.safeParse(metricsSchema, body.metrics)
  const snapshots = v.safeParse(snapshotsSchema, body.snapshots)
  const searchQueries = v.safeParse(searchQueriesSchema, body.searchQueries)
  const toolCalls = v.safeParse(toolCallsSchema, body.toolCalls)
  if (!metrics.success || !snapshots.success || !searchQueries.success || !toolCalls.success) {
    return null
  }
  return {
    metrics: metrics.output,
    snapshots: snapshots.output,
    searchQueries: searchQueries.output,
    toolCalls: toolCalls.output,
  }
}
