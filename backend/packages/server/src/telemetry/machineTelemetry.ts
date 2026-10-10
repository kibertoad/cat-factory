import type {
  AgentContextSnapshot,
  AgentSearchQuery,
  AgentToolCall,
  LlmCallMetric,
} from '@cat-factory/kernel'

// Mothership-mode telemetry INGEST (docs/initiatives/mothership-mode.md, PR 5 — the UPSTREAM half).
//
// Telemetry is the local-first bucket: a mothership-mode node writes every LLM call, dispatch
// context and performed search to a `node:sqlite` store on the laptop, because routing them
// through the per-call persistence RPC would put a network round trip on the hot path of every
// model call. That capture half landed with the store and its retention prune.
//
// What it left open is that the rows never go anywhere. A hosted teammate opening the run a
// laptop drove sees an empty observability panel, zero token rollups and no web-search log — and
// once the local retention window passes, so does the node that produced them. This module is the
// runtime-neutral spine of the sync UP: the wire envelope, the fetch client the laptop posts
// through, and nothing else. It is deliberately a DEDICATED `/internal/*` endpoint rather than a
// hole in the persistence proxy (ADR 0009): the whole reason telemetry is local-first is that its
// writes must not be per-row RPCs, so re-admitting them one at a time would undo the bucket.
//
// The batch is APPEND-ONLY and idempotent by row id, which is what lets the node retry a chunk
// whose ack was lost without corrupting a stored prompt delta (see the ports' `recordMany`).

/** Per-request row caps. A batch above these is refused (413) rather than silently truncated. */
export const TELEMETRY_INGEST_LIMITS = {
  /** Per-call rows: the lightest of the three, though each carries prompt + response bodies. */
  metrics: 200,
  /** Dispatch snapshots: one row is routinely megabytes (composed prompt + injected files). */
  snapshots: 20,
  /** Performed searches: no unbounded body, so the cap is purely on row count. */
  searchQueries: 500,
  /**
   * Tool calls: each carries two bodies, but both are capped at CAPTURE time, so the cap here is
   * a byte budget divided by that ceiling rather than a guess about row shape.
   */
  toolCalls: 500,
} as const

/**
 * Upper bound on a whole ingest request body (characters), checked before parsing costs anything
 * meaningful. The row caps above bound COUNT; this bounds BYTES, which is the axis a single
 * pathological snapshot moves. Generous enough for a full chunk of real rows.
 */
export const MAX_TELEMETRY_INGEST_CHARS = 8_000_000

/**
 * One batch of a single run's captured telemetry, posted to `POST /internal/telemetry/ingest`.
 *
 * `workspaceId` and `executionId` are the SCOPE of the batch, not decoration: the mothership
 * binds the workspace to the token's accounts and then STAMPS both onto every row it stores,
 * ignoring whatever the rows themselves carry. So a node can neither file telemetry into a
 * workspace it cannot already reach, nor smuggle rows for a foreign run through an in-scope one.
 *
 * Each array is optional — a sink with nothing left to upload is simply absent, and an entirely
 * empty batch is a valid no-op ack (the drain posts until a page comes back empty).
 */
export interface TelemetryIngestRequest {
  workspaceId: string
  executionId: string
  metrics?: LlmCallMetric[]
  snapshots?: AgentContextSnapshot[]
  searchQueries?: AgentSearchQuery[]
  toolCalls?: AgentToolCall[]
}

/** How many rows of each sink the mothership actually appended (duplicates included). */
export interface TelemetryIngestResult {
  metrics: number
  snapshots: number
  searchQueries: number
  toolCalls: number
}

/**
 * Thrown when the node holds no machine token yet (booted before the mothership login), so
 * nothing was uploaded and nothing COULD have been.
 *
 * It is an error rather than an empty-but-successful result because the caller's success path
 * advances a high-water mark: a zeroed `TelemetryIngestResult` is indistinguishable from "the run
 * had no rows", which would mark the run uploaded and let the local prune delete rows the
 * mothership never saw. Distinct from a transport failure only so the sweep can log it as the
 * benign, self-healing condition it is — both dispositions leave the mark alone and retry.
 */
export class MachineTokenUnavailableError extends Error {
  constructor() {
    super('no machine token: node has not completed the mothership login yet')
    this.name = 'MachineTokenUnavailableError'
  }
}

/** The client half: uploads one batch of a run's telemetry to the mothership. */
export interface MachineTelemetryClient {
  /**
   * Upload `batch`. Rejects on a transport/HTTP failure — or with
   * {@link MachineTokenUnavailableError} when the node cannot authenticate at all — so the sweep
   * leaves the run's high-water mark alone and retries it next pass. A resolved result therefore
   * always means the mothership stored the range; a partially applied batch is safe to re-offer
   * because the append is idempotent by row id.
   */
  ingest(batch: TelemetryIngestRequest): Promise<TelemetryIngestResult>
}

export interface HttpMachineTelemetryClientOptions {
  baseUrl: string
  /** The machine token, as a fixed string OR a provider read per request (may return null). */
  token: string | (() => string | null)
  fetchImpl?: typeof fetch
  /**
   * Abort the round-trip after this long. Unlike a notification raise, nothing waits on an
   * ingest — it runs on a background sweep — so the timeout is generous enough for a chunk of
   * megabyte-scale snapshot rows on a slow uplink.
   */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 60_000

/**
 * A fetch-based {@link MachineTelemetryClient} posting to a mothership's
 * `POST /internal/telemetry/ingest` with the node's machine token. Mirrors
 * `HttpMachineNotificationClient`'s auth contract (a fixed token OR a per-request provider, so a
 * token cached after boot by the mothership login flow is picked up without a restart).
 */
export class HttpMachineTelemetryClient implements MachineTelemetryClient {
  constructor(private readonly opts: HttpMachineTelemetryClientOptions) {}

  async ingest(batch: TelemetryIngestRequest): Promise<TelemetryIngestResult> {
    const token = typeof this.opts.token === 'function' ? this.opts.token() : this.opts.token
    // No token yet (a node booted before the mothership login): there is nothing to sync to, and a
    // guaranteed-403 upload of megabytes is pure waste — so the upload is SKIPPED, but it is
    // skipped by THROWING. Returning a zeroed result here would read to the sweep as "the range is
    // stored", advancing the run's high-water mark over rows that never left the laptop and
    // handing them to the retention prune. The rows stay local and the run stays a candidate, so
    // the sweep picks it up once the SPA login completes.
    if (!token) throw new MachineTokenUnavailableError()
    const fetchImpl = this.opts.fetchImpl ?? fetch
    const res = await fetchImpl(
      `${this.opts.baseUrl.replace(/\/$/, '')}/internal/telemetry/ingest`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(batch),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      },
    )
    if (!res.ok) {
      throw new Error(`mothership telemetry ingest failed with HTTP ${res.status}`)
    }
    const body = (await res.json()) as { stored?: Partial<TelemetryIngestResult> }
    return {
      metrics: body.stored?.metrics ?? 0,
      snapshots: body.stored?.snapshots ?? 0,
      searchQueries: body.stored?.searchQueries ?? 0,
      toolCalls: body.stored?.toolCalls ?? 0,
    }
  }
}
