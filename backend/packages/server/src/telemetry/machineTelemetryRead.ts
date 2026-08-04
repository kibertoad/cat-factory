import type {
  AgentContextSnapshot,
  AgentContextSnapshotIndex,
  AgentSearchQuery,
  AgentToolCall,
  LlmCallMetric,
  LlmCallMetricPage,
  LlmCallMetricSummary,
} from '@cat-factory/kernel'
import { MAX_AGENT_CONTEXT_TOTAL_CHARS, MAX_BODY_CHARS } from '@cat-factory/orchestration'

// Mothership-mode telemetry READ-THROUGH (docs/initiatives/mothership-mode.md, PR 5 — the last
// piece of the telemetry bucket).
//
// The capture half writes a mothership-mode node's telemetry to a `node:sqlite` store on the
// laptop; the ingest half carries a quiesced run's rows UP so hosted teammates can read them and
// they outlive the node's short local retention window. What both leave open is the read coming
// back DOWN. Three runs render wrong on a mothership-mode node today, and none reports a problem:
//
//   - a run this node drove whose LOCAL rows have already been pruned (the mothership holds them,
//     the laptop no longer does),
//   - a run somebody ELSE drove — a hosted teammate, or another laptop. Its telemetry was never
//     local at all, and in mothership mode the node's SPA shows the whole org's board, so this is
//     the common case rather than the exotic one, and
//   - a run the prune took only PART of, which renders a short list and an understated token total
//     instead of a blank panel — the same false picture, with rows in it to make it convincing.
//     The laptop side (`telemetryReadThrough.ts`) is where that one is detected; what this module
//     owes it is a read that can fetch the missing remainder on the same cursor.
//
// This module is the runtime-neutral spine of the read: the closed table of bounded reads the
// mothership will serve, the wire envelope, and the fetch client the laptop asks through.
//
// It is a DEDICATED `/internal/*` endpoint rather than allow-listed persistence-RPC methods, for
// the same reason the ingest is (ADR 0009), plus one specific to reads: the drift guard asserts
// that a `LOCAL_FIRST_PERSISTENCE_REPOSITORIES` repository appears in no `REMOTE_PERSISTENCE_METHODS`
// entry, because the persistence registry resolves a repository WHOLE — naming one there would
// route its hot-path WRITES over the network, which is the entire thing this bucket exists to
// prevent. A separate table, reached only by the read-through decorator, keeps that invariant
// intact while still letting a rendering surface reach the mothership's copy.

/**
 * The closed set of telemetry reads a mothership will serve, and the bound each one is held to.
 *
 * Every entry is a READ, is scoped to ONE run (or one row of one), and has a size a caller can
 * compute BEFORE the request — the same rule the remote debugging surface obeys
 * (backend/docs/debug-api.md). `listByExecution` appears nowhere: it takes no cursor, so a node
 * asking a long run for "everything" is exactly the un-resumable bulk read this bucket forbids.
 * The read-through answers those methods by DRAINING the paged reads below.
 *
 * `provisioningLogRepository` and `subscriptionQuotaCycleRepository` are absent on purpose: they
 * are local-first and deliberately never ingested (a provisioned environment outlives the run that
 * created it, so "a finished run's rows" does not identify its log; a quota cycle keys on
 * laptop-held credentials). The mothership holds nothing to read through TO.
 */
export const TELEMETRY_READ_METHODS = {
  llmCallMetricRepository: {
    /** Whole-body page of a run's calls — what the observability panel and the export drain. */
    listRunPage: {
      args: 'runQuery',
      maxArgs: 1,
      limit: 'query.limit',
      maxLimit: 100,
      timeoutMs: 30_000,
    },
    /** The debug surface's sliced page. */
    listPage: {
      args: 'runQuery',
      maxArgs: 1,
      limit: 'query.limit',
      maxLimit: 200,
      maxBodyChars: 262_144,
      timeoutMs: 20_000,
    },
    /** One call by id, bodies sliced to the caller's window. */
    get: { args: 'id', maxArgs: 2, limit: null, maxBodyChars: 262_144, timeoutMs: 20_000 },
    /** The `(agentKind, phase)` aggregate every rollup folds over — no rows, no bodies. */
    summarizeByExecution: { args: 'id', maxArgs: 1, limit: null, timeoutMs: 5_000 },
  },
  agentContextSnapshotRepository: {
    /**
     * Whole-body page of a run's dispatches. Capped SMALL, and this is the one entry where the
     * cap is about bytes rather than rows: a snapshot carries the composed prompt plus every
     * injected context file, so the recorder's own per-row ceiling is megabytes.
     */
    listRunPage: {
      args: 'runQuery',
      maxArgs: 1,
      limit: 'query.limit',
      maxLimit: 3,
      timeoutMs: 30_000,
    },
    /** Identity + sizes only, never a body. */
    listIndex: {
      args: 'runQuery',
      maxArgs: 1,
      limit: 'query.limit',
      maxLimit: 200,
      timeoutMs: 10_000,
    },
    get: { args: 'id', maxArgs: 1, limit: null, timeoutMs: 20_000 },
    countByExecution: { args: 'id', maxArgs: 1, limit: null, timeoutMs: 5_000 },
  },
  agentSearchQueryRepository: {
    /** Whole rows, but they carry no unbounded body (the query text is capped at capture). */
    listPage: {
      args: 'runQuery',
      maxArgs: 1,
      limit: 'query.limit',
      maxLimit: 500,
      timeoutMs: 10_000,
    },
    countByExecution: { args: 'id', maxArgs: 1, limit: null, timeoutMs: 5_000 },
  },
  agentToolCallRepository: {
    /**
     * Whole rows, bodies included: a tool call's args/result are capped at CAPTURE time (unlike
     * a prompt body, which is stored whole and sliced at read time), so the page's byte size is
     * `limit x 2 x MAX_TOOL_BODY_CHARS` and computable before the request. The row cap is lower
     * than the search queries' for that reason — those rows carry no body at all — and matches
     * the public debug endpoint's own ceiling, so the mothership can serve no page larger than
     * the one a direct-db deployment would.
     */
    listPage: {
      args: 'runQuery',
      maxArgs: 1,
      limit: 'query.limit',
      maxLimit: 100,
      timeoutMs: 10_000,
    },
    /** The ordered read; bounded by the same ceiling and for the same reason. */
    listByExecution: {
      args: 'runQuery',
      maxArgs: 1,
      limit: 'query.limit',
      maxLimit: 100,
      timeoutMs: 10_000,
    },
    countByExecution: { args: 'id', maxArgs: 1, limit: null, timeoutMs: 5_000 },
  },
} as const satisfies Record<string, Record<string, TelemetryReadBound>>

/**
 * How one entry of {@link TELEMETRY_READ_METHODS} is bounded — on all three axes a caller has to
 * be able to size BEFORE the request: the arguments it may pass, the rows and bytes it may ask
 * back, and how long it may wait.
 */
export interface TelemetryReadBound {
  /**
   * The shape `args` must have, checked before the call is dispatched so a malformed query is a
   * 422 rather than a 500 raised deep inside a repository's SQL. `'runQuery'` takes one object
   * carrying a non-empty `executionId`; `'id'` takes a non-empty string.
   */
  args: 'runQuery' | 'id'
  /** How many positional arguments may follow the STAMPED workspace. */
  maxArgs: number
  /**
   * Where the row cap lives — `'query.limit'` for the `(workspaceId, query)` shape, or null for a
   * read that returns one row or one aggregate and so has no cap to check.
   */
  limit: 'query.limit' | null
  maxLimit?: number
  /**
   * Ceiling on a per-body slice budget. Where this is set the budget is REQUIRED, for the same
   * reason an unstated `limit` is refused: "whole bodies" computes no size, and a read whose size
   * cannot be computed before the request has no place on this surface. A caller that wanted the
   * whole body asks for this ceiling explicitly and reads {@link LlmCallBodySlice.totalChars} to
   * see whether it got all of it.
   */
  maxBodyChars?: number
  /**
   * Round-trip budget, sized to what the read actually moves rather than to one global default.
   * It matters because these reads are not all equally patient: the `(agentKind, phase)` aggregate
   * is folded onto every step settlement by `RunStateMachine.attachStepMetrics`, which awaits it
   * on the emit path, so an unreachable mothership must cost that emit seconds rather than the
   * half-minute a megabyte-scale snapshot page is rightly allowed.
   */
  timeoutMs: number
}

/** A repository name {@link TELEMETRY_READ_METHODS} serves. */
export type TelemetryReadRepository = keyof typeof TELEMETRY_READ_METHODS

/**
 * The per-body slice budget `repo.method` REQUIRES, or null where it takes none.
 *
 * The read-through calls this to fill in a window its own caller left open: a point read with no
 * window means "the whole bodies" to the port, which is exactly the unstated size this surface
 * refuses, so the fallback asks for the declared ceiling instead of being refused. The slice is
 * self-describing (`totalChars` beside the text), so a body longer than the ceiling reports itself
 * as cut rather than passing as whole.
 */
export function telemetryReadBodyCap(repo: TelemetryReadRepository, method: string): number | null {
  const methods = TELEMETRY_READ_METHODS[repo] as Record<string, TelemetryReadBound>
  if (!Object.hasOwn(methods, method)) return null
  return methods[method]?.maxBodyChars ?? null
}

/**
 * Page sizes the laptop-side drain STARTS at. Each is at or below its method's `maxLimit` and
 * sized for the rows that sink typically holds — not for its worst case, which no fixed page size
 * could serve: three whole snapshots at the capture ceiling are ~12 MiB before JSON escaping, and
 * a hundred whole calls ~150 MiB. A page that overruns {@link MAX_TELEMETRY_READ_CHARS} is
 * therefore a ROUTINE condition on a run with large prompts, and the drain halves and retries
 * rather than failing (see {@link TelemetryReadTooLargeError}). Snapshots start at 1 because
 * there is no batching win in a sink whose rows are megabytes apiece.
 */
export const TELEMETRY_READ_PAGE_SIZES = {
  metrics: 100,
  snapshots: 1,
  searchQueries: 500,
  // Two capture-capped bodies per row, so a page is sized against that ceiling rather than the
  // unbounded body a prompt page has to reckon with.
  toolCalls: 100,
} as const

/**
 * Worst-case inflation from JSON string escaping: a body of nothing but `"` or control characters
 * serializes to two characters each. Real bodies sit far below this, but the backstop below has to
 * hold for the pathological one — that is what it is FOR.
 */
const JSON_ESCAPE_WORST_CASE = 2

/**
 * Room for one row's non-body fields — ids, timestamps, token counts, a snapshot's fragment and
 * context-file paths/titles/URLs, and the response envelope itself. Generous on purpose: it is
 * the slack in the inequality that makes {@link MAX_TELEMETRY_READ_CHARS} provably sufficient.
 */
const ROW_METADATA_HEADROOM = 512 * 1024

/**
 * Upper bound on one read RESPONSE (characters). The per-method caps bound row COUNT; this bounds
 * the axis a single pathological row moves. Over it the mothership REFUSES rather than truncating:
 * a shortened page would leave the node paging on a cursor drawn from rows the mothership silently
 * dropped, which loses the tail with nothing left to notice.
 *
 * It is DERIVED from the capture ceilings rather than picked, and the derivation is the property
 * that makes the drain's halving terminate: the backstop is wide enough for the largest SINGLE row
 * either body-bearing sink can store, worst-case escaped, so a request for one row can never be
 * refused for size. Halving therefore always reaches a page that fits, instead of bottoming out at
 * 1 and failing a run permanently — which is what an 8,000,000 constant did, being narrower than a
 * single maximal snapshot (4 MiB × 2 = 8,388,608).
 *
 * `telemetryRead.spec.ts` pins the inequality against BOTH sinks' ceilings, so raising a capture
 * cap without widening this fails a test rather than a developer's panel.
 */
export const MAX_TELEMETRY_READ_CHARS =
  MAX_AGENT_CONTEXT_TOTAL_CHARS * JSON_ESCAPE_WORST_CASE + ROW_METADATA_HEADROOM

/**
 * The largest a single row of a body-bearing sink can serialize to, worst-case escaped. Exported
 * so the conformity assertion in `telemetryRead.spec.ts` states the inequality in one place rather
 * than restating the arithmetic.
 *
 * An LLM call carries three capped bodies ({@link MAX_BODY_CHARS} each: prompt delta, response,
 * reasoning); a snapshot carries one shared budget across both prompts, every fragment and every
 * injected file.
 */
export const MAX_TELEMETRY_READ_ROW_CHARS =
  Math.max(MAX_BODY_CHARS * 3, MAX_AGENT_CONTEXT_TOTAL_CHARS) * JSON_ESCAPE_WORST_CASE

/**
 * One bounded telemetry read, posted to `POST /internal/telemetry/read`.
 *
 * `workspaceId` is the SCOPE, not an argument: the mothership binds it to the token's accounts
 * and then PREPENDS it as the call's first argument, so `args` carries everything AFTER it. A
 * node therefore cannot address a workspace it cannot already reach even by naming one in `args`
 * — the same stamping property the ingest applies to a row's `workspaceId`.
 */
export interface TelemetryReadRequest {
  workspaceId: string
  repo: TelemetryReadRepository
  method: string
  /** The call's arguments AFTER `workspaceId`. JSON-serializable by construction. */
  args: unknown[]
}

/**
 * The read's result. Plain JSON rather than the persistence RPC's tagged envelope: every method
 * in the table returns an array, a number or a nullable row, so there is no `undefined`/`null`
 * distinction to preserve and no in-place `rev` to write back.
 */
export type TelemetryReadResponse =
  | { ok: true; value: unknown }
  | { ok: false; error: { code: string; message: string } }

/** The typed results the read-through expects back, per method. */
export interface TelemetryReadResults {
  'llmCallMetricRepository.listRunPage': LlmCallMetric[]
  'llmCallMetricRepository.listPage': LlmCallMetricPage[]
  'llmCallMetricRepository.get': LlmCallMetricPage | null
  'llmCallMetricRepository.summarizeByExecution': LlmCallMetricSummary[]
  'agentContextSnapshotRepository.listRunPage': AgentContextSnapshot[]
  'agentContextSnapshotRepository.listIndex': AgentContextSnapshotIndex[]
  'agentContextSnapshotRepository.get': AgentContextSnapshot | null
  'agentContextSnapshotRepository.countByExecution': number
  'agentSearchQueryRepository.listPage': AgentSearchQuery[]
  'agentSearchQueryRepository.countByExecution': number
  'agentToolCallRepository.listPage': AgentToolCall[]
  'agentToolCallRepository.listByExecution': AgentToolCall[]
  'agentToolCallRepository.countByExecution': number
}

/** The client half: performs one bounded telemetry read against the mothership. */
export interface MachineTelemetryReadClient {
  /**
   * Perform `request`. REJECTS on any failure — transport, HTTP, an unreachable mothership, or a
   * node with no machine token — and never resolves to an empty result standing in for one.
   *
   * That contract is the whole point. The caller is a rendering surface that fell back here
   * BECAUSE its local store held nothing, so an empty resolution would be reported to the reader
   * as "this run spent nothing / captured nothing" — the exact false-zero the read-through
   * exists to remove. A rejection surfaces as a failed panel, which is the honest answer.
   */
  read(request: TelemetryReadRequest): Promise<unknown>
}

export interface HttpMachineTelemetryReadClientOptions {
  baseUrl: string
  /** The machine token, as a fixed string OR a provider read per request (may return null). */
  token: string | (() => string | null)
  fetchImpl?: typeof fetch
  /**
   * Abort the round-trip after this long, OVERRIDING the per-method budget the request's own
   * {@link TelemetryReadBound.timeoutMs} would otherwise supply. For tests and for a deployment
   * that has to widen every read at once; leave it unset in production so an aggregate folded onto
   * the emit path keeps its short budget while a snapshot page keeps its long one.
   */
  timeoutMs?: number
}

/**
 * Fallback round-trip budget for a method the table does not name. Unreachable through the
 * read-through (its calls are all table entries), so this only covers a hand-built request.
 */
const DEFAULT_TIMEOUT_MS = 20_000

/** The `error.code` a mothership uses for a response that overran {@link MAX_TELEMETRY_READ_CHARS}. */
export const TELEMETRY_READ_TOO_LARGE_CODE = 'response_too_large'

/**
 * The refusal a caller can DO something about: the rows it asked for were within their row cap but
 * serialized past the byte backstop, so the same cursor with a smaller page will fit.
 *
 * Distinct from every other refusal precisely so the drain can tell "ask for less" from "you asked
 * for something you may not have" (an over-cap limit, an unknown method — client bugs, where
 * retrying smaller would just fail more slowly). Retrying is CORRECT rather than a clamp in
 * disguise: the keyset cursor only ever advances over rows actually received, so a narrower page
 * loses nothing, where the server silently shortening one would.
 */
export class TelemetryReadTooLargeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TelemetryReadTooLargeError'
  }
}

/**
 * A fetch-based {@link MachineTelemetryReadClient} posting to a mothership's
 * `POST /internal/telemetry/read` with the node's machine token. Same auth contract as
 * `HttpMachineTelemetryClient` (a fixed token OR a per-request provider, so a token cached after
 * boot by the mothership login flow is picked up without a restart).
 */
export class HttpMachineTelemetryReadClient implements MachineTelemetryReadClient {
  constructor(private readonly opts: HttpMachineTelemetryReadClientOptions) {}

  async read(request: TelemetryReadRequest): Promise<unknown> {
    const token = typeof this.opts.token === 'function' ? this.opts.token() : this.opts.token
    // No token yet (a node booted before the mothership login): there is nothing to read from,
    // and this THROWS rather than returning an empty result for the reason the port states — a
    // fallback that answers empty reports a false zero to whoever is looking at the panel.
    if (!token) throw new MachineTokenUnavailableForReadError()
    const fetchImpl = this.opts.fetchImpl ?? fetch
    const res = await fetchImpl(`${this.opts.baseUrl.replace(/\/$/, '')}/internal/telemetry/read`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? timeoutFor(request)),
    })
    const body = (await res.json().catch(() => null)) as TelemetryReadResponse | null
    if (!body || !('ok' in body)) {
      throw new Error(`mothership telemetry read failed with HTTP ${res.status}`)
    }
    if (!body.ok) {
      const refusal = `${body.error.code} ${body.error.message}`
      // The one refusal a caller can act on rather than report — see the error's own note.
      if (body.error.code === TELEMETRY_READ_TOO_LARGE_CODE) {
        throw new TelemetryReadTooLargeError(`mothership telemetry read refused: ${refusal}`)
      }
      throw new Error(`mothership telemetry read refused: ${refusal}`)
    }
    return body.value
  }
}

/** The round-trip budget `request`'s method declares, or the fallback for one off the table. */
function timeoutFor(request: TelemetryReadRequest): number {
  const methods: Record<string, TelemetryReadBound> | undefined = Object.hasOwn(
    TELEMETRY_READ_METHODS,
    request.repo,
  )
    ? TELEMETRY_READ_METHODS[request.repo]
    : undefined
  const bound = methods && Object.hasOwn(methods, request.method) ? methods[request.method] : null
  return bound?.timeoutMs ?? DEFAULT_TIMEOUT_MS
}

/**
 * Thrown when the node holds no machine token yet, so the read could not be attempted.
 *
 * Distinct from a transport failure only so a caller can report the benign, self-healing case
 * ("finish the mothership login") differently from a broken one. Both are rejections, for the
 * reason {@link MachineTelemetryReadClient.read} states.
 */
export class MachineTokenUnavailableForReadError extends Error {
  constructor() {
    super('no machine token: node has not completed the mothership login yet')
    this.name = 'MachineTokenUnavailableForReadError'
  }
}
