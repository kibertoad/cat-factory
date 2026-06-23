import { DatadogApiError, datadogApiBase } from './datadog.logic.js'

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

export class DatadogClient {
  private readonly fetchImpl: FetchLike

  constructor(
    private readonly creds: DatadogCredentials,
    options: DatadogClientOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  /** Read a monitor's overall state (`GET /api/v1/monitor/{id}`). */
  async getMonitor(id: string): Promise<DatadogMonitorState> {
    const data = await this.get<{ name?: string; overall_state?: string }>(`/api/v1/monitor/${id}`)
    return { id, name: data.name ?? `monitor ${id}`, overallState: data.overall_state }
  }

  /**
   * Read an SLO's current SLI value vs target over a window
   * (`GET /api/v1/slo/{id}/history`). Returns nulls when Datadog has no data.
   */
  async getSloState(id: string, fromTs: number, toTs: number): Promise<DatadogSloState> {
    const data = await this.get<{
      data?: {
        slo?: { name?: string };
        overall?: { sli_value?: number | null };
        thresholds?: Record<string, { target?: number }>;
      }
    }>(`/api/v1/slo/${id}/history?from_ts=${fromTs}&to_ts=${toTs}`)
    const overall = data.data?.overall
    const thresholds = data.data?.thresholds ?? {}
    const target = Object.values(thresholds)[0]?.target ?? null
    return {
      id,
      name: data.data?.slo?.name ?? `slo ${id}`,
      sliValue: typeof overall?.sli_value === 'number' ? overall.sli_value : null,
      target: typeof target === 'number' ? target : null,
    }
  }

  /**
   * Aggregate recent error logs (`POST /api/v2/logs/analytics/aggregate`) into the top
   * error groups for the window. Best-effort: a query failure yields an empty list (the
   * monitor/SLO signals are the gate's primary verdict).
   */
  async recentErrorLogs(query: string, fromMs: number, toMs: number, limit = 5): Promise<DatadogLogSample[]> {
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
      throw new DatadogApiError(path, `HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`)
    }
    return (await res.json()) as T
  }
}
