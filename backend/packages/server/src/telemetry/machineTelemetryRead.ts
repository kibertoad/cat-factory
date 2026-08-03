import type {
  AgentContextSnapshot,
  AgentContextSnapshotIndex,
  AgentSearchQuery,
  LlmCallMetric,
  LlmCallMetricPage,
  LlmCallMetricSummary,
} from '@cat-factory/kernel'

// Mothership-mode telemetry READ-THROUGH (docs/initiatives/mothership-mode.md, PR 5 — the last
// piece of the telemetry bucket).
//
// The capture half writes a mothership-mode node's telemetry to a `node:sqlite` store on the
// laptop; the ingest half carries a quiesced run's rows UP so hosted teammates can read them and
// they outlive the node's short local retention window. What both leave open is the read coming
// back DOWN. Two runs render blank on a mothership-mode node today, and neither reports a problem:
//
//   - a run this node drove whose LOCAL rows have already been pruned (the mothership holds them,
//     the laptop no longer does), and
//   - a run somebody ELSE drove — a hosted teammate, or another laptop. Its telemetry was never
//     local at all, and in mothership mode the node's SPA shows the whole org's board, so this is
//     the common case rather than the exotic one.
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
    listRunPage: { limit: 'query.limit', maxLimit: 100 },
    /** The debug surface's sliced page. */
    listPage: { limit: 'query.limit', maxLimit: 200, maxBodyChars: 262_144 },
    /** One call by id, bodies sliced to the caller's window. */
    get: { limit: null, maxBodyChars: 262_144 },
    /** The `(agentKind, phase)` aggregate every rollup folds over — no rows, no bodies. */
    summarizeByExecution: { limit: null },
  },
  agentContextSnapshotRepository: {
    /**
     * Whole-body page of a run's dispatches. Capped SMALL, and this is the one entry where the
     * cap is about bytes rather than rows: a snapshot carries the composed prompt plus every
     * injected context file, so the recorder's own per-row ceiling is megabytes.
     */
    listRunPage: { limit: 'query.limit', maxLimit: 3 },
    /** Identity + sizes only, never a body. */
    listIndex: { limit: 'query.limit', maxLimit: 200 },
    get: { limit: null },
    countByExecution: { limit: null },
  },
  agentSearchQueryRepository: {
    /** Whole rows, but they carry no unbounded body (the query text is capped at capture). */
    listPage: { limit: 'query.limit', maxLimit: 500 },
    countByExecution: { limit: null },
  },
} as const satisfies Record<string, Record<string, TelemetryReadBound>>

/** How one entry of {@link TELEMETRY_READ_METHODS} is bounded. */
export interface TelemetryReadBound {
  /**
   * Where the row cap lives — `'query.limit'` for the `(workspaceId, query)` shape, or null for a
   * read that returns one row or one aggregate and so has no cap to check.
   */
  limit: 'query.limit' | null
  maxLimit?: number
  /** Ceiling on a per-body slice budget, where the read takes one. */
  maxBodyChars?: number
}

/** A repository name {@link TELEMETRY_READ_METHODS} serves. */
export type TelemetryReadRepository = keyof typeof TELEMETRY_READ_METHODS

/**
 * Page sizes the laptop-side drain asks for. Deliberately at or below each method's `maxLimit`
 * and sized so a page comfortably fits the response backstop — a 413 is therefore a bug or an
 * attack, not a routine condition the client has to unwind, which is why the client treats one
 * as a failure rather than halving and retrying.
 */
export const TELEMETRY_READ_PAGE_SIZES = {
  metrics: 100,
  snapshots: 3,
  searchQueries: 500,
} as const

/**
 * Upper bound on one read RESPONSE (characters). The per-method caps above bound row COUNT; this
 * bounds the axis a single pathological snapshot moves. Over it the mothership refuses rather
 * than truncating: a shortened page would leave the node paging on a cursor drawn from rows the
 * mothership silently dropped, which loses the tail with nothing left to notice.
 */
export const MAX_TELEMETRY_READ_CHARS = 8_000_000

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
   * Abort the round-trip after this long. A human is waiting on this one (unlike the ingest
   * sweep), so it is far tighter than the upload's — but still generous enough for a page of
   * megabyte-scale snapshot rows.
   */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 20_000

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
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    })
    const body = (await res.json().catch(() => null)) as TelemetryReadResponse | null
    if (!body || !('ok' in body)) {
      throw new Error(`mothership telemetry read failed with HTTP ${res.status}`)
    }
    if (!body.ok) {
      throw new Error(`mothership telemetry read refused: ${body.error.code} ${body.error.message}`)
    }
    return body.value
  }
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
