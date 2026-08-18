import { DatadogApiError, datadogApiBase, datadogAuthRemedy } from './datadog.logic.js'

// A thin, runtime-neutral wrapper over the Datadog API (plain `fetch`, no SDK), so it
// runs identically in a Workers isolate and under Node. Only the handful of reads the
// post-release-health gate + on-call investigation need: a monitor's state, an SLO's
// current SLI vs target, and a recent error-log sample. Auth is the standard
// DD-API-KEY / DD-APPLICATION-KEY header pair. The base host is validated upstream.

type FetchLike = typeof fetch

export interface DatadogCredentials {
  site: string
  apiKey: string
  appKey: string
}

/** A monitor's current state. */
export interface DatadogMonitorState {
  id: string
  name: string
  overallState: string | undefined
  /** When the monitor last triggered (epoch ms), if any group reported it. */
  stateModifiedMs?: number
}

/** An SLO's current SLI value vs its target (the breach check). */
export interface DatadogSloState {
  id: string
  name: string
  sliValue: number | null
  target: number | null
}

/** One recent error-log group. */
export interface DatadogLogSample {
  title: string
  count?: number
  sampleMessage?: string
}

export interface DatadogClientOptions {
  fetchImpl?: FetchLike
}

/**
 * Pick the SLO target to compare the window SLI against. Datadog's SLO-history response
 * keys `thresholds` by timeframe (e.g. `7d` / `30d` / `90d`), and a multi-timeframe SLO
 * can carry a different target per timeframe — so `Object.values(...)[0]` would compare
 * the (short) release-window SLI against whichever timeframe Datadog happened to list
 * first, a non-deterministic, often-wrong verdict. Pick the SHORTEST configured timeframe
 * deterministically: it is the one most sensitive to a just-shipped regression and is a
 * stable choice across calls. Falls back to the only/first target when timeframes are
 * unparseable, and to `null` when there are none (Datadog has no data).
 */
function pickSloTarget(thresholds: Record<string, { target?: number }>): number | null {
  const entries = Object.entries(thresholds)
  if (entries.length === 0) return null
  const days = (timeframe: string): number => {
    const m = /^(\d+)\s*([smhdwy])$/.exec(timeframe.trim())
    if (!m) return Number.POSITIVE_INFINITY
    const n = Number(m[1])
    const unit = { s: 1 / 86400, m: 1 / 1440, h: 1 / 24, d: 1, w: 7, y: 365 }[m[2]!] ?? 1
    return n * unit
  }
  const sorted = [...entries].sort((a, b) => days(a[0]) - days(b[0]))
  for (const [, threshold] of sorted) {
    if (typeof threshold.target === 'number') return threshold.target
  }
  return null
}

/**
 * Parse a Datadog timestamp into epoch ms. Monitor state timestamps are epoch SECONDS; other
 * endpoints report ISO-8601. Returns undefined when absent or unparseable.
 */
function parseDatadogTimestamp(value: string | number | undefined): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value * 1000 : undefined
  if (typeof value === 'string' && value.trim() !== '') {
    const ms = Date.parse(value)
    return Number.isNaN(ms) ? undefined : ms
  }
  return undefined
}

/**
 * The most recent trigger across a monitor's groups, in epoch ms.
 *
 * A multi-group monitor alerts per group, so the question the gate asks ("did this start after
 * the release marker?") is answered by the LATEST trigger: one group that triggered after the
 * release makes the alert this release's, whatever the others did earlier. Undefined when no
 * group carries a timestamp, which the caller reads as unknown rather than as old.
 */
function latestTriggeredMs(
  groups: Record<string, { last_triggered_ts?: number }> | undefined,
): number | undefined {
  let latest: number | undefined
  for (const group of Object.values(groups ?? {})) {
    const ms = parseDatadogTimestamp(group.last_triggered_ts)
    if (ms !== undefined && (latest === undefined || ms > latest)) latest = ms
  }
  return latest
}

export class DatadogClient {
  private readonly fetchImpl: FetchLike

  constructor(
    private readonly creds: DatadogCredentials,
    options: DatadogClientOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  /**
   * Read a monitor's overall state and when it last triggered (`GET /api/v1/monitor/{id}`).
   *
   * `group_states=all` is what makes the second half answerable. This used to read
   * `overall_state_modified`, a field Datadog's v1 `Monitor` schema does not define (it appears
   * only on Synthetics v2), so the transition time was silently ALWAYS absent: the gate then
   * attributed every standing alert to the release it was watching, because "unknown" is
   * deliberately treated as "escalate". The documented timestamps are per GROUP, under
   * `state.groups.<group>.last_triggered_ts` in epoch seconds, and `state` is populated only when
   * the request asks for it.
   */
  async getMonitor(id: string): Promise<DatadogMonitorState> {
    const data = await this.get<{
      name?: string
      overall_state?: string
      state?: { groups?: Record<string, { last_triggered_ts?: number }> }
    }>(`/api/v1/monitor/${id}?group_states=all`)
    const stateModifiedMs = latestTriggeredMs(data.state?.groups)
    return {
      id,
      name: data.name ?? `monitor ${id}`,
      overallState: data.overall_state,
      ...(stateModifiedMs !== undefined ? { stateModifiedMs } : {}),
    }
  }

  /**
   * Read an SLO's current SLI value vs target over a window
   * (`GET /api/v1/slo/{id}/history`). Returns nulls when Datadog has no data.
   */
  async getSloState(id: string, fromTs: number, toTs: number): Promise<DatadogSloState> {
    const data = await this.get<{
      data?: {
        slo?: { name?: string }
        overall?: { sli_value?: number | null }
        thresholds?: Record<string, { target?: number }>
      }
    }>(`/api/v1/slo/${id}/history?from_ts=${fromTs}&to_ts=${toTs}`)
    const overall = data.data?.overall
    const thresholds = data.data?.thresholds ?? {}
    const target = pickSloTarget(thresholds)
    return {
      id,
      name: data.data?.slo?.name ?? `slo ${id}`,
      sliValue: typeof overall?.sli_value === 'number' ? overall.sli_value : null,
      target,
    }
  }

  /**
   * Aggregate recent error logs (`POST /api/v2/logs/analytics/aggregate`) into the top
   * error groups for the window. Best-effort: a query failure yields an empty list (the
   * monitor/SLO signals are the gate's primary verdict).
   */
  async recentErrorLogs(
    query: string,
    fromMs: number,
    toMs: number,
    limit = 5,
  ): Promise<DatadogLogSample[]> {
    try {
      const body = {
        compute: [{ aggregation: 'count', type: 'total' }],
        filter: { from: String(fromMs), to: String(toMs), query },
        group_by: [{ facet: '@error.type', limit, sort: { aggregation: 'count', order: 'desc' } }],
      }
      const data = await this.post<{
        data?: { buckets?: { by?: Record<string, string>; computes?: Record<string, number> }[] }
      }>(`/api/v2/logs/analytics/aggregate`, body)
      const buckets = data.data?.buckets ?? []
      return buckets.map((b) => {
        const title = Object.values(b.by ?? {})[0] ?? 'error'
        const count = Object.values(b.computes ?? {})[0]
        return { title: String(title), count: typeof count === 'number' ? count : undefined }
      })
    } catch {
      return []
    }
  }

  private async get<T>(path: string): Promise<T> {
    const res = await this.fetchImpl(`${datadogApiBase(this.creds.site)}${path}`, {
      method: 'GET',
      headers: this.headers(),
    })
    return this.parse<T>(path, res)
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await this.fetchImpl(`${datadogApiBase(this.creds.site)}${path}`, {
      method: 'POST',
      headers: { ...this.headers(), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return this.parse<T>(path, res)
  }

  private headers(): Record<string, string> {
    return {
      'DD-API-KEY': this.creds.apiKey,
      'DD-APPLICATION-KEY': this.creds.appKey,
      accept: 'application/json',
    }
  }

  private async parse<T>(path: string, res: Response): Promise<T> {
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      // On an auth rejection (401/403) append the UI-first remedy naming the keys panel; the raw
      // `HTTP <status>: <body>` is preserved ahead of it as the diagnostic detail.
      const remedy = datadogAuthRemedy(res.status)
      const detail = `HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}${
        remedy ? ` — ${remedy}` : ''
      }`
      throw new DatadogApiError(path, detail)
    }
    return (await res.json()) as T
  }
}
