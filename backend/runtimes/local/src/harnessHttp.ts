import {
  CONTAINER_EVICTION_ERROR,
  HARNESS_SHUTDOWN_ERROR,
  harnessDispatchError,
  readRunnerDispatchAck,
  type HarnessCallMetric,
  type RunnerDispatchAck,
  type RunnerJobView,
} from '@cat-factory/kernel'

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
 * re-drive it — mirroring the Worker transport's 404 mapping. Re-exported from kernel
 * (`CONTAINER_EVICTION_ERROR`), which owns the wording as a cross-transport contract, so the
 * local transports keep importing it from the protocol module they already share.
 */
export const EVICTION_ERROR = CONTAINER_EVICTION_ERROR

/** The shared-secret header sent on every harness call. */
const SECRET_HEADER = 'x-harness-secret'

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
async function safeText(res: Response): Promise<string> {
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
}): Promise<RunnerDispatchAck | undefined> {
  const res = await opts.fetchImpl(harnessUrl(opts.endpoint, '/jobs'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', [SECRET_HEADER]: opts.secret },
    body: JSON.stringify(opts.body),
    signal: AbortSignal.timeout(opts.timeoutMs),
  })
  if (!res.ok) {
    // Structured DispatchError (carrying the HTTP status) so consumers classify by field, not
    // regex; a 404 on the harness /jobs route elaborates to the stale-image republish remedy.
    throw harnessDispatchError({ label: opts.label, status: res.status, body: await safeText(res) })
  }
  // The capability handshake the harness put on its acceptance. Unreadable ⇒ undefined, which
  // the dispatch site reads as "could not tell", never as a refusal and never as a reason to
  // fail a job the harness has already accepted.
  return readRunnerDispatchAck(await safeJson(res))
}

/**
 * Ask a harness to stop ONE job (`DELETE /jobs/{id}`) and CONFIRM that it did, resolving only when
 * the job has left `running`. Throws otherwise, so the caller reports an honest failure to stop
 * instead of a stop that never happened.
 *
 * Every non-2xx is a failure to confirm, the 404 included: it is what a caller addressing a
 * recreated harness sees just as much as one addressing a reaped job, and only one of those means
 * nothing is running. A caller that can prove the job is gone by other means (no container at all)
 * decides that for itself rather than reading it into a status code.
 */
export async function stopHarnessJob(opts: {
  fetchImpl: typeof fetch
  endpoint: HarnessEndpoint
  jobId: string
  secret: string
  timeoutMs: number
  label: string
}): Promise<void> {
  const res = await opts.fetchImpl(
    harnessUrl(opts.endpoint, `/jobs/${encodeURIComponent(opts.jobId)}`),
    {
      method: 'DELETE',
      headers: { [SECRET_HEADER]: opts.secret },
      signal: AbortSignal.timeout(opts.timeoutMs),
    },
  )
  if (!res.ok) {
    throw new Error(`${opts.label} job stop failed (HTTP ${res.status}): ${await safeText(res)}`)
  }
  const state = (await safeJson(res)) as { state?: unknown } | undefined
  if (state?.state === 'running') {
    throw new Error(`${opts.label} job stop did not settle: the job is still running`)
  }
}

/** The acceptance body as JSON, or undefined when it cannot be read. Never throws. */
async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json()
  } catch {
    return undefined
  }
}

/**
 * Which eviction branch the poll fell to, i.e. what the post-mortem is entitled to conclude
 * about the backend it is about to read:
 *   - `unreachable`: the backend did not answer and `isDead` confirmed it is gone. Whatever it
 *     was serving when it died was THIS job, so its exit state and output are this job's last
 *     words.
 *   - `job_unknown`: the backend answered 404. It is ALIVE and has simply forgotten the job (its
 *     harness restarted, or reaped it). Anything read off it now describes whatever it is
 *     serving, which on a SHARED backend is a different run.
 *
 * The distinction only matters where a backend outlives a single run (the local warm pool), but
 * it is the poll that establishes it, so it is the poll that has to say which one happened.
 */
export type EvictionCause = 'unreachable' | 'job_unknown'

/**
 * What a caller can tell about a backend that has stopped serving its job: how it died (prose for
 * the failure `detail`) and whether that death was a clean exit (the verdict). Both optional, both
 * best-effort; a caller that supplies neither gets the plain eviction.
 */
interface HarnessDeathReaders {
  exitedCleanly?: () => boolean | Promise<boolean>
  postMortem?: (cause: EvictionCause) => Promise<string | undefined>
}

/**
 * GET a harness job view by id. A 404 (job unknown/reaped, or the harness was recreated) maps to a
 * terminal death view; a connection error consults `isDead` — true ⇒ the same, false ⇒ rethrow the
 * transient error so the caller retries. Any other non-OK status throws a `<label>`-prefixed error.
 * `isDead` is also where the caller performs its own cleanup (drop a dead pool member / clear a
 * stale cache entry).
 *
 * `postMortem` (optional) is the LAST chance to read anything off the dying backend: it runs
 * only on a death branch, and its text rides the view's `detail` through to the run's
 * recorded failure. A container that dies MID-RUN is otherwise reclaimed (`release()` removes
 * it) with its stdout — the only record of WHY the harness process exited — destroyed, leaving
 * a bare "container evicted or crashed" and nothing to diagnose from. It is handed the
 * {@link EvictionCause} so it can refuse to attribute a live backend's output to this run.
 *
 * `exitedCleanly` (optional) separates the two ways a harness stops serving a job: one that CRASHED
 * or was reclaimed, versus one that exited 0 while this job was still running, i.e. was shut down.
 * Only the caller can tell (it owns the process or the container), and only the second reading is
 * terminal. See {@link HARNESS_SHUTDOWN_ERROR}. A caller that cannot tell leaves it out and every
 * death stays an eviction, which is the reading that costs a fresh container rather than a run.
 *
 * It is asked on BOTH eviction branches, because the question is not whether the backend that
 * ANSWERED exited: it is whether the one this job was handed to did. On a backend that outlives a
 * run (the native host process, the warm pool) those are routinely different, and the 404 is then
 * the REPLACEMENT never having heard of the job — the same shutdown, reported as an eviction and
 * re-dispatched into whatever caused it, purely because a sibling job's re-dispatch respawned the
 * harness first. The caller answers for the backend THIS job was dispatched to (both local
 * transports key that off the dispatch generation / the run's own container), so a live backend
 * answering a 404 still yields false.
 */
export async function pollHarnessJob(
  opts: {
    fetchImpl: typeof fetch
    endpoint: HarnessEndpoint
    jobId: string
    secret: string
    timeoutMs: number
    label: string
    isDead: () => boolean | Promise<boolean>
  } & HarnessDeathReaders,
): Promise<RunnerJobView> {
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
    if (await opts.isDead()) return deathView(opts, 'unreachable')
    throw err
  }
  if (res.status === 404) return deathView(opts, 'job_unknown')
  if (!res.ok) {
    throw new Error(`${opts.label} job poll failed (HTTP ${res.status}): ${await safeText(res)}`)
  }
  return (await res.json()) as RunnerJobView
}

/**
 * The terminal view for a job whose backend stopped serving it, on either eviction branch: the
 * caller's post-mortem as the failure `detail`, and its clean-exit reading as the verdict.
 */
async function deathView(opts: HarnessDeathReaders, cause: EvictionCause): Promise<RunnerJobView> {
  const detail = await postMortemOf(opts, cause)
  return (await exitedCleanlyOf(opts)) ? shutdownView(detail) : evictionView(detail)
}

/** The terminal eviction view, carrying the caller's post-mortem as the failure `detail`. */
function evictionView(detail: string | undefined): RunnerJobView {
  return {
    state: 'failed',
    error: EVICTION_ERROR,
    evicted: 'crash',
    ...(detail ? { detail } : {}),
  }
}

/**
 * The terminal SHUTDOWN view: the harness exited cleanly with this job still in flight.
 *
 * Deliberately carries no `evicted` verdict, because it is not one and the engine's recovery is
 * keyed on that field: something stopped the harness, and re-dispatching the same step into a
 * fresh one only reproduces whatever did.
 */
function shutdownView(detail: string | undefined): RunnerJobView {
  return {
    state: 'failed',
    error: HARNESS_SHUTDOWN_ERROR,
    harnessShutdown: true,
    ...(detail ? { detail } : {}),
  }
}

/** Run the caller's post-mortem, if any. Best-effort: a diagnostic never fails the poll. */
async function postMortemOf(
  opts: HarnessDeathReaders,
  cause: EvictionCause,
): Promise<string | undefined> {
  if (!opts.postMortem) return undefined
  return opts.postMortem(cause).catch(() => undefined)
}

/**
 * Read the caller's clean-exit verdict, if any. Best-effort in the same way the post-mortem is,
 * and for a sharper reason: this runs on a branch that has already established the job is over, so
 * a runtime read that throws (a `docker inspect` against a daemon that just went away) must still
 * leave the poll with a death to report. Unreadable ⇒ false, the reading that costs a container
 * rather than the run.
 */
async function exitedCleanlyOf(opts: HarnessDeathReaders): Promise<boolean> {
  if (!opts.exitedCleanly) return false
  return Promise.resolve()
    .then(() => opts.exitedCleanly?.() ?? false)
    .catch(() => false)
}

/** The inline completion a finished `inline` job records (mirrors the harness `InlineResult`). */
export interface InlineJobResult {
  text: string
  finishReason?: 'stop' | 'length'
  /**
   * The input side split into its three orthogonal classes (`inputTokens` is FRESH input,
   * exclusive of both caches), mirroring the harness's `InlineResult.usage`. A harness image
   * predating the split omits the cache fields, which reads as 0 — the same answer it gave
   * when it reported one lumped count.
   */
  usage?: {
    inputTokens?: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
    outputTokens?: number
  }
  /**
   * Every model call the harness's CLI made, lifted off its event stream — the same per-call
   * telemetry a CODING job returns, which the harness already assembles for an inline job and
   * this shape simply had nowhere to put. An inline job is one `generateText` to its caller but a
   * whole tool loop to the CLI, so without these the step's spend collapses into the lumped
   * {@link usage} above: right in total, silent about how many turns produced it and what each
   * one carried. Absent on a harness image that reports none, which degrades to that lumped row.
   */
  callMetrics?: HarnessCallMetric[]
}

/** The harness `/jobs/{id}` view for an `inline` job (its own result shape, not RunnerJobView). */
export interface InlineJobView {
  state: 'running' | 'done' | 'failed'
  result?: InlineJobResult
  error?: string
}

/**
 * GET an INLINE harness job by id. Same eviction semantics as {@link pollHarnessJob} (a 404 or
 * a connection error against a dead backend maps to a terminal eviction), but typed for the
 * inline result shape ({@link InlineJobResult}) rather than the coding {@link RunnerJobView}.
 */
export async function pollInlineJob(opts: {
  fetchImpl: typeof fetch
  endpoint: HarnessEndpoint
  jobId: string
  secret: string
  timeoutMs: number
  isDead: () => boolean | Promise<boolean>
}): Promise<InlineJobView> {
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
    throw new Error(`Inline container job poll failed (HTTP ${res.status}): ${await safeText(res)}`)
  }
  return (await res.json()) as InlineJobView
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

/**
 * The `version` a harness self-reports on `/health`, or undefined when it doesn't (an old
 * harness predating the field, or any error). Used by the version handshake (see
 * harnessVersion.ts) to detect a stale/mismatched executor. Never throws — an undefined
 * result is itself meaningful (treated as a stale signal by the caller).
 */
export async function fetchHarnessVersion(
  fetchImpl: typeof fetch,
  endpoint: HarnessEndpoint,
  secret: string,
  requestTimeoutMs: number,
): Promise<string | undefined> {
  try {
    const res = await fetchImpl(harnessUrl(endpoint, '/health'), {
      method: 'GET',
      headers: { [SECRET_HEADER]: secret },
      signal: AbortSignal.timeout(Math.min(requestTimeoutMs, 5_000)),
    })
    if (!res.ok) return undefined
    const body = (await res.json().catch(() => ({}))) as { version?: unknown }
    return typeof body.version === 'string' && body.version.trim() ? body.version.trim() : undefined
  } catch {
    return undefined
  }
}

/**
 * An error message that may be composed lazily (only on the failure branch). The container
 * transport's messages fold in a tail of the container's own logs — an extra CLI call we
 * must NOT pay on every healthy boot — so it passes a thunk that runs only when the loop
 * actually throws.
 */
type LazyError = string | (() => string | Promise<string>)

const resolveLazyError = async (e: LazyError): Promise<string> =>
  typeof e === 'function' ? await e() : e

/**
 * Poll `/health` until OK or the deadline, throwing on timeout (or if `isDead` fires). Both
 * local runner transports speak the identical protocol, so this loop lives here ONCE rather
 * than being hand-rolled per transport (see the file header). `isDead` may be async (the
 * container transport consults the runtime), and the error messages may be thunks composed
 * lazily on the failure branch only.
 *
 * `probeFirst` selects the liveness/probe ORDER each tick:
 * - `false` (default): check `isDead` BEFORE probing, so an authoritative+cheap death signal
 *   (the native-process transport's `handle.exited`) fails fastest.
 * - `true`: probe `/health` FIRST and RETURN if it answers, only consulting `isDead` when it
 *   doesn't. The container transport needs this — a serving harness whose `docker inspect`
 *   momentarily reports not-running (inspect lag / a race) must still be accepted, with a real
 *   death surfacing later at the job poll, rather than aborting dispatch on a stale liveness read.
 */
export async function waitForHarnessHealth(opts: {
  fetchImpl: typeof fetch
  endpoint: HarnessEndpoint
  readyTimeoutMs: number
  requestTimeoutMs: number
  intervalMs?: number
  isDead?: () => boolean | Promise<boolean>
  deadError?: LazyError
  timeoutError: LazyError
  probeFirst?: boolean
}): Promise<void> {
  const deadline = Date.now() + opts.readyTimeoutMs
  const throwDead = async (): Promise<never> => {
    throw new Error(
      await resolveLazyError(opts.deadError ?? 'the harness exited before becoming healthy'),
    )
  }
  for (;;) {
    if (!opts.probeFirst && (await opts.isDead?.())) await throwDead()
    if (await harnessHealthy(opts.fetchImpl, opts.endpoint, opts.requestTimeoutMs)) return
    // Not healthy yet: only NOW (after the probe) consult liveness in probe-first mode, so a
    // healthy-but-liveness-lagging backend was already accepted above.
    if (opts.probeFirst && (await opts.isDead?.())) await throwDead()
    if (Date.now() >= deadline) throw new Error(await resolveLazyError(opts.timeoutError))
    await delay(opts.intervalMs ?? 300)
  }
}
