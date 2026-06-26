import type { RunnerJobView } from '@cat-factory/kernel'

// Shared HTTP plumbing for talking to an executor-harness instance over its `/jobs` +
// `/health` API. Both local runner transports — the per-run/pooled CONTAINER transport
// (LocalContainerRunnerTransport) and the native HOST-PROCESS transport
// (LocalProcessRunnerTransport) — speak the identical protocol, so it lives here ONCE
// rather than being copied between them: a protocol change (a header, the request shape,
// or the eviction-marker string orchestration's `isContainerEvictionError` matches) is
// then made in a single place instead of silently drifting per transport.

/**
 * The failed-poll error the engine classifies as a container eviction (matched by
 * orchestration `isContainerEvictionError`, also used by the bootstrap flow). A
 * vanished/exited harness maps to it so the run stops and the stale-run sweeper can
 * re-drive it — mirroring the Worker transport's 404 mapping.
 */
export const EVICTION_ERROR = 'Job not found (container evicted or crashed)'

/** The shared-secret header sent on every harness call. */
export const SECRET_HEADER = 'x-harness-secret'

/** Where a harness instance is reachable. */
export interface HarnessEndpoint {
  host: string
  port: number
}

export const harnessUrl = (endpoint: HarnessEndpoint, path: string): string =>
  `http://${endpoint.host}:${endpoint.port}${path}`

export const delay = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))

/** A bounded, never-throwing read of a response body for an error message. */
export async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500)
  } catch {
    return '(no body)'
  }
}

/** POST a job body to the harness `/jobs`, throwing a `<label>`-prefixed error on non-OK. */
export async function postHarnessJob(opts: {
  fetchImpl: typeof fetch
  endpoint: HarnessEndpoint
  secret: string
  body: Record<string, unknown>
  timeoutMs: number
  label: string
}): Promise<void> {
  const res = await opts.fetchImpl(harnessUrl(opts.endpoint, '/jobs'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', [SECRET_HEADER]: opts.secret },
    body: JSON.stringify(opts.body),
    signal: AbortSignal.timeout(opts.timeoutMs),
  })
  if (!res.ok) {
    throw new Error(`${opts.label} dispatch failed (HTTP ${res.status}): ${await safeText(res)}`)
  }
}

/**
 * GET a harness job view by id. A 404 (job unknown/reaped, or the harness was recreated)
 * maps to an eviction view; a connection error consults `isDead` — true ⇒ eviction (the
 * backend is gone), false ⇒ rethrow the transient error so the caller retries. Any other
 * non-OK status throws a `<label>`-prefixed error. `isDead` is also where the caller
 * performs its own cleanup (drop a dead pool member / clear a stale cache entry).
 */
export async function pollHarnessJob(opts: {
  fetchImpl: typeof fetch
  endpoint: HarnessEndpoint
  jobId: string
  secret: string
  timeoutMs: number
  label: string
  isDead: () => boolean | Promise<boolean>
}): Promise<RunnerJobView> {
  let res: Response
  try {
    res = await opts.fetchImpl(
      harnessUrl(opts.endpoint, `/jobs/${encodeURIComponent(opts.jobId)}`),
      {
        method: 'GET',
        headers: { [SECRET_HEADER]: opts.secret },
        signal: AbortSignal.timeout(opts.timeoutMs),
      },
    )
  } catch (err) {
    if (await opts.isDead()) return { state: 'failed', error: EVICTION_ERROR }
    throw err
  }
  if (res.status === 404) return { state: 'failed', error: EVICTION_ERROR }
  if (!res.ok) {
    throw new Error(`${opts.label} job poll failed (HTTP ${res.status}): ${await safeText(res)}`)
  }
  return (await res.json()) as RunnerJobView
}

/** A single quick `/health` probe (no retry); false on any error/non-OK. */
export async function harnessHealthy(
  fetchImpl: typeof fetch,
  endpoint: HarnessEndpoint,
  requestTimeoutMs: number,
): Promise<boolean> {
  try {
    const res = await fetchImpl(harnessUrl(endpoint, '/health'), {
      method: 'GET',
      signal: AbortSignal.timeout(Math.min(requestTimeoutMs, 5_000)),
    })
    return res.ok
  } catch {
    return false
  }
}

/** Poll `/health` until OK or the deadline, throwing on timeout (or if `isDead` fires). */
export async function waitForHarnessHealth(opts: {
  fetchImpl: typeof fetch
  endpoint: HarnessEndpoint
  readyTimeoutMs: number
  requestTimeoutMs: number
  intervalMs?: number
  isDead?: () => boolean
  deadError?: string
  timeoutError: string
}): Promise<void> {
  const deadline = Date.now() + opts.readyTimeoutMs
  for (;;) {
    if (opts.isDead?.()) {
      throw new Error(opts.deadError ?? 'the harness exited before becoming healthy')
    }
    if (await harnessHealthy(opts.fetchImpl, opts.endpoint, opts.requestTimeoutMs)) return
    if (Date.now() >= deadline) throw new Error(opts.timeoutError)
    await delay(opts.intervalMs ?? 300)
  }
}
