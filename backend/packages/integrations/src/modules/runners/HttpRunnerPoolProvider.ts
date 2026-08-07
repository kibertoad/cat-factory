import type {
  ConnectionTestResult,
  HarnessCallMetric,
  ProviderConfigField,
  RunnerDispatchAck,
  RunnerDispatchRequest,
  RunnerJobResult,
  RunnerJobStopOutcome,
  RunnerValidationReport,
  RunnerReproductionPhase,
  RunnerReproductionReport,
  RunnerJobView,
  RunnerPollRequest,
  RunnerPoolAuthScheme,
  RunnerPoolConnectionTestRequest,
  RunnerPoolManifest,
  RunnerPoolProvider,
  RunnerPoolRequestTemplate,
  RunnerObservedToolServer,
  RunnerSliceReview,
  SecretResolver,
  UrlSafetyPolicy,
} from '@cat-factory/kernel'
import {
  CONTAINER_EVICTION_ERROR,
  isHarnessFailureCause,
  readRunnerDispatchAck,
  STRICT_URL_SAFETY_POLICY,
} from '@cat-factory/kernel'
import { DOCS } from '../../docs.js'
import * as environmentsLogic from '../environments/environments.logic.js'
import { type MakeHttpError, readCappedText, safeFetch } from '../shared/safe-fetch.js'
import * as runnersLogic from './runners.logic.js'

// The single generic adapter that interprets ANY runner-pool manifest. There are
// no per-org presets: an org's pool scheduler API is described as HTTP request
// templates with `{{var}}` interpolation, an auth scheme, and a dot-path mapping
// from its (arbitrary) status response onto the canonical harness job view. This
// is the runner-pool sibling of HttpEnvironmentProvider and reuses the same
// generic primitives (interpolation, dot-path extraction, the SSRF guard).
//
// Runtime-neutral (`fetch` + Web APIs only), so both the Cloudflare Worker and the
// Node service drive an org's self-hosted pool through one shared implementation.
//
// Security: every URL is SSRF-guarded before it is fetched; the per-tenant
// scheduler secrets are resolved in-memory via the injected resolver and only
// ever placed in request headers — never logged or echoed in errors (error
// bodies are length-capped and carry no request headers). The per-job GitHub +
// LLM-proxy tokens travel inside the interpolated dispatch body (the runner needs
// them) and are likewise never logged.

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_RESPONSE_CHARS = 200_000
/** Hard cap on the bytes read off any response body (mirrors MAX_RESPONSE_CHARS). */
const MAX_RESPONSE_BYTES = MAX_RESPONSE_CHARS
const USER_AGENT = 'cat-factory'

/**
 * UI-first remedy appended to every runner-pool error: a self-hosted pool is registered,
 * credentialed, and re-tested in the UI, so the primary fix instruction names that click path
 * (the pool scheduler URL / auth / manifest all live there). Kept self-sufficient without the
 * doc link. The raw `Runner pool <method> → <status>` / `Missing secret 'X'` first part is
 * PRESERVED verbatim ahead of it (greppable + surfaced as the connection-test / dispatch detail).
 */
const RUNNER_POOL_REMEDY =
  `Re-test the connection in Settings → Self-hosted runner pool, and update the pool's scheduler ` +
  `URL, credentials, or manifest there if they changed. See ${DOCS.runnerPool()}.`

/**
 * Carries the HTTP status so callers can surface a meaningful (redacted) error, and appends the
 * shared UI-first {@link RUNNER_POOL_REMEDY} so every runner-pool failure (a scheduler non-2xx, a
 * missing manifest secret, an OAuth-token rejection) names where to fix it — whether it surfaces
 * as a connection-test message, a dispatch failure, or a log line.
 */
export class RunnerPoolApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(`${message} — ${RUNNER_POOL_REMEDY}`)
    this.name = 'RunnerPoolApiError'
  }
}

/** Redirect/size failures from the shared SSRF-safe fetch surface as this provider's error. */
const makeRunnerError: MakeHttpError = (status, message) =>
  new RunnerPoolApiError(status, `Runner pool ${message.toLowerCase()}`)

export interface HttpRunnerPoolProviderOptions {
  defaultTimeoutMs?: number
  /** URL/host safety policy; defaults to strict (https-only, no private hosts). */
  urlPolicy?: UrlSafetyPolicy
}

export class HttpRunnerPoolProvider implements RunnerPoolProvider {
  private readonly defaultTimeoutMs: number
  private readonly urlPolicy: UrlSafetyPolicy
  /** Per-isolate OAuth token cache, keyed by token URL + client id. */
  private readonly oauthCache = new Map<string, { token: string; expiresAt: number }>()

  constructor(options: HttpRunnerPoolProviderOptions = {}) {
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS
    this.urlPolicy = options.urlPolicy ?? STRICT_URL_SAFETY_POLICY
  }

  async dispatch(req: RunnerDispatchRequest): Promise<RunnerDispatchAck | undefined> {
    const json = await this.execute(
      req.manifest,
      req.manifest.dispatch,
      this.scope(req.jobId, req.spec),
      req.resolveSecret,
    )
    // The capability handshake, IF the manifest says where in the scheduler's response the
    // harness's acceptance body lands. Manifest-mapped like every other pool field, and for a
    // sharper reason than consistency: `capabilities` is an ordinary word, and a scheduler that
    // answers with its OWN (`["gpu","docker"]`) would be read as a harness reporting a list with
    // neither `mcpServers` nor `skills` in it: an `unsupported` verdict that HARD-REFUSES every
    // capability dispatch against a perfectly current image. Guessing cannot tell the two apart;
    // the operator can, in one line. Unmapped ⇒ unknown, which is the truth about a control plane
    // this backend knows nothing about. See `domain/harness-capabilities.ts`.
    const path = req.manifest.response.dispatchCapabilitiesPath
    if (!path) return undefined
    return readRunnerDispatchAck({
      capabilities: environmentsLogic.extractByPath(json, path),
    })
  }

  async poll(req: RunnerPollRequest): Promise<RunnerJobView> {
    let json: unknown
    try {
      json = await this.execute(
        req.manifest,
        req.manifest.poll,
        this.scope(req.jobId),
        req.resolveSecret,
      )
    } catch (error) {
      // The scheduler no longer knows this job (404 Not Found / 410 Gone): its runner is gone
      // and the job with it. Report it as an EVICTION rather than letting the throw count
      // against the poll-failure tolerance, so the engine re-dispatches onto a fresh pool
      // member instead of spending ~3 minutes of retries and then failing the run. Mirrors the
      // Cloudflare container and Kubernetes transports, which map their own 404 the same way.
      //
      // The status leads the sentinel, and the scheduler's own account rides `detail`, because
      // a 404 is NOT proof of an eviction: a mistyped `poll` path template (dispatch uses a
      // different one, so it can be right while this is wrong) and a scheduler that 404s an
      // unauthorized read both land here. Those are misconfigurations, and an operator handed a
      // bare "container evicted or crashed" has nothing to work from — the raw status line plus
      // this provider's fix-it remedy is what names the real problem. `evicted or crashed` stays
      // a SUBSTRING, which is all `isContainerEvictionError` needs.
      if (error instanceof RunnerPoolApiError && (error.status === 404 || error.status === 410)) {
        return {
          state: 'failed',
          error: `Runner pool poll → ${error.status}: ${CONTAINER_EVICTION_ERROR}`,
          evicted: 'crash',
          detail: error.message,
        }
      }
      throw error
    }
    return this.mapJobView(req.manifest, json)
  }

  async release(req: RunnerPollRequest): Promise<RunnerJobStopOutcome> {
    // No template ⇒ nothing happens, and saying so is the point: this same call is a caller's only
    // way to CANCEL a pool job, so a silent `void` return here reads as a job that was stopped.
    if (!req.manifest.release) return 'unsupported'
    await this.execute(req.manifest, req.manifest.release, this.scope(req.jobId), req.resolveSecret)
    // The scheduler accepted the call. Whether its runner actually stopped is behind a control
    // plane with no read this backend can make, so `requested` is the strongest honest answer.
    return 'requested'
  }

  /** A manifest-driven pool: the config IS the manifest, so describe its secret keys. */
  describeConfig(manifest?: RunnerPoolManifest): ProviderConfigField[] {
    if (!manifest) return []
    return environmentsLogic.configFieldsFromSecretKeys(runnersLogic.referencedSecretKeys(manifest))
  }

  /** Probe the scheduler API with the candidate manifest's auth (nothing dispatched). */
  async testConnection(req: RunnerPoolConnectionTestRequest): Promise<ConnectionTestResult> {
    if (!req.manifest) return { ok: false, message: 'No manifest supplied to test.' }
    let headers: Record<string, string>
    try {
      headers = await this.authHeaders(req.manifest.auth, req.resolveSecret)
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
    return environmentsLogic.probeConnection(req.manifest.baseUrl, headers, this.urlPolicy)
  }

  // --- internals ----------------------------------------------------------

  /**
   * The bounded interpolation scope a template sees:
   *   - `{{input.jobId}}` — the id the pool is keyed on (sticky routing target);
   *   - `{{input.job}}`   — the full harness job spec as JSON, so a body template can
   *                         forward it verbatim (`{"payload":{{input.job}}}`);
   *   - `{{input.kind}}`  — the harness job kind (`run` | `blueprint` | `spec` |
   *                         `explore` | `bootstrap` | `ci-fix` | `resolve-conflicts` |
   *                         `merge` | `on-call` | `test` | `fix-tests`). The harness
   *                         itself reads the kind from the job body (`POST /jobs`), so
   *                         a manifest does NOT need to route by kind; this is exposed
   *                         flat only so a manifest can map it to a scheduler-side
   *                         node selector / queue / resource hint without decoding the
   *                         embedded `{{input.job}}` JSON;
   *   - `{{input.instanceType}}` / `{{input.cloudProvider}}` — the provisioning hints
   *                         the transport stamped on for a self-provisioning pool
   *                         (present only when the service pins a size/provider), so a
   *                         manifest can map them to a node selector / resource request
   *                         / queue without decoding `{{input.job}}`;
   *   - `{{input.image}}` — the image variant the dispatch needs (`ui` | `deploy`,
   *                         present only when stamped on), so a manifest can pull the
   *                         heavier Playwright image or the deploy-harness image
   *                         (kubectl/kustomize/helm) instead of the default executor.
   * Reuses the environments interpolation machinery; the second (`provision`)
   * namespace is unused by runner manifests.
   */
  private scope(
    jobId: string,
    spec?: Record<string, unknown>,
  ): environmentsLogic.InterpolationScope {
    const input: Record<string, string> = {
      jobId,
      job: spec ? JSON.stringify(spec) : '',
    }
    // Surface the routing/sizing hints the RunnerPoolTransport stamps onto the
    // dispatch spec as first-class `{{input.*}}` variables. They live inside
    // `{{input.job}}` too, but a path/query/header template can't reach into that JSON
    // string — exposing them flat lets a manifest route-by-kind and size declaratively.
    for (const key of ['kind', 'instanceType', 'cloudProvider', 'image'] as const) {
      const value = spec?.[key]
      if (typeof value === 'string') input[key] = value
    }
    return { input, provision: {} }
  }

  private async execute(
    manifest: RunnerPoolManifest,
    template: RunnerPoolRequestTemplate,
    scope: environmentsLogic.InterpolationScope,
    resolveSecret: SecretResolver,
  ): Promise<unknown> {
    const url = this.buildUrl(manifest.baseUrl, template, scope)

    const headers: Record<string, string> = {
      accept: 'application/json',
      'user-agent': USER_AGENT,
      ...(await this.authHeaders(manifest.auth, resolveSecret)),
    }
    for (const h of template.headers ?? []) {
      headers[h.name] = environmentsLogic.interpolateTemplate(h.value, scope)
    }

    let body: string | undefined
    if (template.bodyTemplate !== undefined && template.method !== 'GET') {
      body = environmentsLogic.interpolateTemplate(template.bodyTemplate, scope)
      if (!headers['content-type']) headers['content-type'] = 'application/json'
    }

    // The dispatch body carries the per-run GitHub + LLM-proxy tokens (and, for a
    // subscription harness, a raw personal credential), so a redirect MUST be re-guarded:
    // follow by hand and re-run the SSRF check on every hop so a permitted scheduler host
    // can't 302 the request — and its body — to an internal / metadata target.
    const res = await safeFetch(
      url,
      {
        method: template.method,
        headers,
        body,
        signal: AbortSignal.timeout(template.timeoutMs ?? this.defaultTimeoutMs),
      },
      (u) => environmentsLogic.assertSafeEnvironmentUrl(u, 'request URL', this.urlPolicy),
      makeRunnerError,
    )

    if (!res.ok) {
      const errText = await readCappedText(res, MAX_RESPONSE_BYTES, makeRunnerError, false).catch(
        () => '',
      )
      throw new RunnerPoolApiError(
        res.status,
        `Runner pool ${template.method} → ${res.status}: ${errText.slice(0, 300)}`,
      )
    }
    const text = await readCappedText(res, MAX_RESPONSE_BYTES, makeRunnerError)
    if (!text) return {}
    try {
      return JSON.parse(text)
    } catch {
      return {}
    }
  }

  private buildUrl(
    baseUrl: string,
    template: RunnerPoolRequestTemplate,
    scope: environmentsLogic.InterpolationScope,
  ): string {
    const base = baseUrl.replace(/\/+$/, '')
    const path = environmentsLogic.interpolateTemplate(template.pathTemplate, scope)
    let url = path ? `${base}${path.startsWith('/') ? '' : '/'}${path}` : base
    const query = (template.query ?? [])
      .map(
        (q) =>
          `${encodeURIComponent(q.key)}=${encodeURIComponent(
            environmentsLogic.interpolateTemplate(q.value, scope),
          )}`,
      )
      .join('&')
    if (query) url += `${url.includes('?') ? '&' : '?'}${query}`
    return url
  }

  private async authHeaders(
    auth: RunnerPoolAuthScheme,
    resolveSecret: SecretResolver,
  ): Promise<Record<string, string>> {
    const secret = (key: string): string => {
      const value = resolveSecret(key)
      if (value === undefined) throw new RunnerPoolApiError(500, `Missing secret '${key}'`)
      return value
    }
    switch (auth.type) {
      case 'none':
        return {}
      case 'api_key':
        return { [auth.headerName]: `${auth.valuePrefix ?? ''}${secret(auth.secretRef.key)}` }
      case 'bearer':
        return { authorization: `Bearer ${secret(auth.secretRef.key)}` }
      case 'basic':
        return {
          authorization: `Basic ${btoa(
            `${secret(auth.usernameSecretRef.key)}:${secret(auth.passwordSecretRef.key)}`,
          )}`,
        }
      case 'oauth2_client_credentials':
        return { authorization: `Bearer ${await this.oauthToken(auth, secret)}` }
      case 'custom_headers': {
        const headers: Record<string, string> = {}
        for (const h of auth.headers) headers[h.name] = secret(h.secretRef.key)
        return headers
      }
    }
  }

  private async oauthToken(
    auth: Extract<RunnerPoolAuthScheme, { type: 'oauth2_client_credentials' }>,
    secret: (key: string) => string,
  ): Promise<string> {
    const clientId = secret(auth.clientIdSecretRef.key)
    const cacheKey = `${auth.tokenUrl}::${clientId}`
    const cached = this.oauthCache.get(cacheKey)
    if (cached && cached.expiresAt > Date.now() + 5_000) return cached.token

    const form = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: secret(auth.clientSecretSecretRef.key),
    })
    if (auth.scope) form.set('scope', auth.scope)
    if (auth.audience) form.set('audience', auth.audience)

    // The client-credentials POST body carries `client_secret`, so — as with `execute` —
    // re-guard every redirect hop rather than letting the runtime chase the secret off-host.
    const res = await safeFetch(
      auth.tokenUrl,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
          'user-agent': USER_AGENT,
        },
        body: form.toString(),
        signal: AbortSignal.timeout(this.defaultTimeoutMs),
      },
      (u) => environmentsLogic.assertSafeEnvironmentUrl(u, 'OAuth token URL', this.urlPolicy),
      makeRunnerError,
    )
    if (!res.ok) {
      const text = await readCappedText(res, MAX_RESPONSE_BYTES, makeRunnerError, false).catch(
        () => '',
      )
      throw new RunnerPoolApiError(
        res.status,
        `OAuth token request → ${res.status}: ${text.slice(0, 200)}`,
      )
    }
    const tokenText = await readCappedText(res, MAX_RESPONSE_BYTES, makeRunnerError)
    const json = (() => {
      try {
        return JSON.parse(tokenText) as { access_token?: string; expires_in?: number }
      } catch {
        return null
      }
    })()
    if (!json?.access_token) {
      throw new RunnerPoolApiError(502, 'OAuth token response missing access_token')
    }
    const ttlMs = (typeof json.expires_in === 'number' ? json.expires_in : 300) * 1000
    this.oauthCache.set(cacheKey, { token: json.access_token, expiresAt: Date.now() + ttlMs })
    return json.access_token
  }

  /** Project the scheduler's arbitrary status response onto the canonical view. */
  private mapJobView(manifest: RunnerPoolManifest, json: unknown): RunnerJobView {
    const r = manifest.response
    const rawStatus = environmentsLogic.extractString(json, r.statusPath)
    const { state, evicted } = runnersLogic.classifyJobStatus(rawStatus, r.statusMap)
    const error = environmentsLogic.extractString(json, r.errorPath)

    const view: RunnerJobView = { state }
    // A scheduler that reports its runner was reclaimed (evicted / preempted / OOM-killed /
    // node lost) describes INFRASTRUCTURE loss, not the job's own verdict, so it rides the
    // structured eviction field and the engine retries on a fresh pool member.
    if (evicted) view.evicted = evicted

    const progress = this.mapProgress(manifest, json)
    if (progress) view.progress = progress

    // The harness liveness heartbeat (epoch ms), when the manifest maps it — so a long, quiet phase
    // on a pool-backed run still refreshes the step's throttled `lastActivityAt`, exactly like a
    // Cloudflare container. Best-effort: a missing/non-numeric value is simply not forwarded.
    const heartbeatAt = this.mapHeartbeat(manifest, json)
    if (heartbeatAt !== undefined) view.heartbeatAt = heartbeatAt

    // Forward-looking follow-up items the Coder streamed since the last poll (drain-on-read),
    // when the manifest maps them. Surfaced on every poll (running or done) so a fast final
    // burst isn't lost. Best-effort: a malformed entry is dropped.
    const followUps = this.mapFollowUps(manifest, json)
    if (followUps && followUps.length > 0) view.followUps = followUps

    // Per-model-call telemetry the harness drained on this poll, when the manifest maps it —
    // so a pool-backed run's calls reach `llm_call_metrics` as they happen, exactly like a
    // Cloudflare/local container, instead of only from the terminal result (which a run that
    // dies mid-flight never produces).
    const callMetrics = this.mapCallMetrics(manifest, json)
    if (callMetrics) view.callMetrics = callMetrics

    // The latest pre-PR validation attempt, when the manifest maps it — so a pool-backed run
    // shows the repair loop while it runs, exactly like a Cloudflare/local container. Unlike the
    // drain channels above this is a latest-value publish, so re-reading it is harmless.
    const validationReport = this.mapValidationReport(manifest, json)
    if (validationReport) view.validationReport = validationReport

    // The latest bugfix reproduction-proof attempt, when the manifest maps it — a latest-value
    // publish like the validation report above, so re-reading it is harmless.
    const reproductionReport = this.mapReproductionReport(manifest, json)
    if (reproductionReport) view.reproductionReport = reproductionReport

    // A parallel PR review's per-slice reviews, when the manifest maps them — a latest-value
    // publish like the two reports above. Forwarded on every poll (running or done): unlike those,
    // this channel is the ONLY thing that makes a finished slice durable before the reviewer's
    // terminal output, so a pool-backed review that never gets there has nothing for a manual
    // resume to work from without it.
    const sliceReviews = this.mapSliceReviews(manifest, json)
    if (sliceReviews) view.sliceReviews = sliceReviews

    // What the agent's CLI reported about the tool servers it loaded, when the manifest maps it —
    // a latest-value publish like the reports above. An unmapped path injects NOTHING rather than
    // an empty list, which is what keeps "this pool does not proxy the channel" from rendering as
    // "the CLI loaded no servers" on a run whose servers were all healthy.
    const toolServers = this.mapToolServers(manifest, json)
    if (toolServers) view.toolServers = toolServers

    // The harness's structured failure cause + extended diagnostic, when the manifest maps
    // them — so a pool that proxies the executor-harness verbatim classifies a failure exactly
    // like a Cloudflare container, instead of degrading to the engine's error-string regex.
    // The mapped value is arbitrary scheduler JSON, so it is narrowed to the kernel
    // {@link HarnessFailureCause} union here — a free-form/unknown value is dropped, which
    // degrades to the same regex fallback as a pool that maps no cause at all.
    const failureCause = environmentsLogic.extractString(json, r.failureCausePath)
    const detail = environmentsLogic.extractString(json, r.detailPath)
    if (isHarnessFailureCause(failureCause)) view.failureCause = failureCause
    if (detail) view.detail = detail

    if (state === 'failed') {
      view.error =
        error ??
        (evicted
          ? `Runner pool reported the runner was reclaimed ('${rawStatus}') — ${CONTAINER_EVICTION_ERROR}`
          : 'Runner pool reported the job failed')
      return view
    }

    if (state === 'done') {
      const result: NonNullable<RunnerJobView['result']> = {}
      // The WHOLE structured work product when the scheduler exposes the harness
      // `result` envelope: forwards EVERY product (blueprint tree, spec, merge
      // assessment, test report, bootstrap branch, …), not just the PR scalars — so a
      // pool-backed tester/merger/blueprinter reaches the engine intact.
      if (r.resultPath) {
        Object.assign(
          result,
          coerceRunnerResult(environmentsLogic.extractByPath(json, r.resultPath)),
        )
      }
      // Individual scalar paths still apply (and override) for schedulers that surface
      // the PR url / branch / summary outside any result envelope.
      const prUrl = environmentsLogic.extractString(json, r.prUrlPath)
      const branch = environmentsLogic.extractString(json, r.branchPath)
      const summary = environmentsLogic.extractString(json, r.summaryPath)
      if (prUrl) result.prUrl = prUrl
      if (branch) result.branch = branch
      if (summary) result.summary = summary
      // A structured error on an otherwise-"done" job is still a failure; the
      // executor maps a result-level `error` to a failed step.
      if (error) result.error = error
      view.result = result
    }
    return view
  }

  /** The harness liveness heartbeat (epoch ms) the manifest maps, coerced to a finite number. */
  private mapHeartbeat(manifest: RunnerPoolManifest, json: unknown): number | undefined {
    const raw = environmentsLogic.extractString(json, manifest.response.heartbeatPath)
    if (raw === undefined) return undefined
    const n = Number(raw)
    return Number.isFinite(n) ? n : undefined
  }

  private mapProgress(
    manifest: RunnerPoolManifest,
    json: unknown,
  ): RunnerJobView['progress'] | undefined {
    const r = manifest.response
    const num = (path: string | undefined): number | undefined => {
      const raw = environmentsLogic.extractString(json, path)
      if (raw === undefined) return undefined
      const n = Number(raw)
      return Number.isFinite(n) ? n : undefined
    }
    const completed = num(r.progressCompletedPath)
    const inProgress = num(r.progressInProgressPath)
    const total = num(r.progressTotalPath)
    if (completed === undefined && inProgress === undefined && total === undefined) return undefined
    return { completed: completed ?? 0, inProgress: inProgress ?? 0, total: total ?? 0 }
  }

  /** Coerce the manifest-mapped follow-up array into the canonical shape (best-effort). */
  private mapFollowUps(
    manifest: RunnerPoolManifest,
    json: unknown,
  ): RunnerJobView['followUps'] | undefined {
    const path = manifest.response.followUpsPath
    if (!path) return undefined
    const raw = environmentsLogic.extractByPath(json, path)
    if (!Array.isArray(raw)) return undefined
    const items: NonNullable<RunnerJobView['followUps']> = []
    for (const entry of raw) {
      if (typeof entry !== 'object' || entry === null) continue
      const e = entry as Record<string, unknown>
      const title = typeof e.title === 'string' ? e.title.trim() : ''
      if (!title) continue
      items.push({
        kind: e.kind === 'question' ? 'question' : 'follow_up',
        title,
        ...(typeof e.detail === 'string' ? { detail: e.detail } : {}),
        ...(typeof e.suggestedAction === 'string' ? { suggestedAction: e.suggestedAction } : {}),
      })
    }
    return items
  }

  /**
   * Coerce the manifest-mapped per-poll call-telemetry array into the canonical shape. Reuses
   * the SAME coercion the terminal result envelope goes through, so the live and terminal
   * channels can't validate a call differently on a pool-backed run.
   */
  private mapCallMetrics(
    manifest: RunnerPoolManifest,
    json: unknown,
  ): RunnerJobView['callMetrics'] | undefined {
    const path = manifest.response.callMetricsPath
    if (!path) return undefined
    const metrics = coerceCallMetrics(environmentsLogic.extractByPath(json, path))
    return metrics.length > 0 ? metrics : undefined
  }

  /**
   * Project the scheduler's live pre-PR validation report onto the canonical view, when the
   * manifest maps it. Runs the SAME coercion as the terminal result envelope so the live and
   * terminal channels can't validate a report differently on a pool-backed run.
   */
  private mapValidationReport(
    manifest: RunnerPoolManifest,
    json: unknown,
  ): RunnerJobView['validationReport'] | undefined {
    const path = manifest.response.validationReportPath
    if (!path) return undefined
    return coerceValidationReport(environmentsLogic.extractByPath(json, path))
  }

  /**
   * Project the scheduler's live bugfix reproduction proof onto the canonical view, when the
   * manifest maps it. Runs the SAME coercion as the terminal result envelope so the live and
   * terminal channels can't validate a verdict differently on a pool-backed run.
   */
  private mapReproductionReport(
    manifest: RunnerPoolManifest,
    json: unknown,
  ): RunnerJobView['reproductionReport'] | undefined {
    const path = manifest.response.reproductionReportPath
    if (!path) return undefined
    return coerceReproductionReport(environmentsLogic.extractByPath(json, path))
  }

  /**
   * Project the scheduler's live per-slice PR reviews onto the canonical view, when the manifest
   * maps them. Coerced per ENTRY — one malformed slice must not discard the good reports beside it,
   * since discarding them is the exact data loss this channel exists to prevent — and an empty
   * result injects nothing, so a pool that maps the path but has no slices yet is indistinguishable
   * from one that maps nothing.
   */
  private mapSliceReviews(
    manifest: RunnerPoolManifest,
    json: unknown,
  ): RunnerJobView['sliceReviews'] | undefined {
    const path = manifest.response.sliceReviewsPath
    if (!path) return undefined
    const reviews = coerceSliceReviews(environmentsLogic.extractByPath(json, path))
    return reviews.length > 0 ? reviews : undefined
  }

  /**
   * Project the scheduler's tool-server startup report onto the canonical view, when the manifest
   * maps it. Coerced per ENTRY like the slices above — the rows are independent facts about
   * independent servers — and an empty result injects nothing, so a pool that maps the path for a
   * job which wired no tool servers is indistinguishable from one that maps nothing. That is the
   * right collapse here: neither case is evidence that a server failed.
   */
  private mapToolServers(
    manifest: RunnerPoolManifest,
    json: unknown,
  ): RunnerJobView['toolServers'] | undefined {
    const path = manifest.response.toolServersPath
    if (!path) return undefined
    const observed = coerceObservedToolServers(environmentsLogic.extractByPath(json, path))
    return observed.length > 0 ? observed : undefined
  }
}

/**
 * Coerce a scheduler's `toolServers` envelope into canonical {@link RunnerObservedToolServer}
 * entries, dropping anything unusable. Mirrors the executor-harness's shape.
 *
 * An entry needs a non-empty `id`: it is the only key the engine can pair an observation to the
 * dispatch's own record by, so an id-less row describes a server nobody can name. `status` is
 * narrowed to the union and anything unrecognised reads as `unknown` rather than being dropped —
 * the safe direction, because dropping reads as a server the CLI never loaded (a different fault
 * with a different fix), while `unknown` says exactly what happened: the CLI named a state this
 * deployment cannot map.
 */
function coerceObservedToolServers(raw: unknown): RunnerObservedToolServer[] {
  if (!Array.isArray(raw)) return []
  const observed: RunnerObservedToolServer[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const o = entry as Record<string, unknown>
    if (typeof o.id !== 'string' || !o.id.trim()) continue
    const server: RunnerObservedToolServer = {
      id: o.id,
      status: isObservedToolServerStatus(o.status) ? o.status : 'unknown',
    }
    // `0` is a server that connected and exposed no tools — the most diagnostic count there is,
    // and the one a truthiness guard would silently turn into "not counted".
    if (typeof o.toolCount === 'number' && Number.isFinite(o.toolCount) && o.toolCount >= 0) {
      server.toolCount = o.toolCount
    }
    observed.push(server)
  }
  return observed
}

const OBSERVED_TOOL_SERVER_STATUSES: ReadonlySet<string> = new Set([
  'ready',
  'failed',
  'needs_auth',
  'unknown',
])

function isObservedToolServerStatus(value: unknown): value is RunnerObservedToolServer['status'] {
  return typeof value === 'string' && OBSERVED_TOOL_SERVER_STATUSES.has(value)
}

/**
 * Coerce a scheduler's `sliceReviews` envelope into canonical {@link RunnerSliceReview} entries,
 * dropping anything unusable. Mirrors the executor-harness's shape.
 *
 * An entry needs a non-empty `label`: it is the only key a resume can pair a report to the
 * reviewer's plan by, so an unlabelled one is noise. `status` is narrowed rather than passed
 * through, and anything that is not verbatim `completed` reads as `in_progress` — the safe
 * direction, because over-reporting `completed` would make a resume SKIP a slice nobody reviewed,
 * while over-reporting `in_progress` only costs re-reviewing one.
 */
function coerceSliceReviews(raw: unknown): RunnerSliceReview[] {
  if (!Array.isArray(raw)) return []
  const reviews: RunnerSliceReview[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const o = entry as Record<string, unknown>
    if (typeof o.label !== 'string' || !o.label.trim()) continue
    const review: RunnerSliceReview = {
      label: o.label,
      status: o.status === 'completed' ? 'completed' : 'in_progress',
    }
    if (typeof o.report === 'string') review.report = o.report
    reviews.push(review)
  }
  return reviews
}

/**
 * Coerce a scheduler's `reproductionReport` envelope into the canonical
 * {@link RunnerReproductionReport}. Returns undefined for anything that isn't a report-shaped
 * object, so a malformed/absent envelope injects nothing (and the run behaves as if it carried no
 * reproduction declaration — which, for a pool that doesn't proxy the field, it effectively did).
 *
 * `status` is narrowed to the union rather than passed through: an unrecognised value would reach
 * the pull-request report as a verdict about a defect, and the safe reading of "I don't know what
 * this says" is `inconclusive`, never `reproduced`. Mirrors the executor-harness's shape.
 */
function coerceReproductionReport(raw: unknown): RunnerReproductionReport | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const o = raw as Record<string, unknown>
  if (typeof o.command !== 'string') return undefined
  const status =
    o.status === 'reproduced' || o.status === 'declared_infeasible' ? o.status : 'inconclusive'
  const testPaths = Array.isArray(o.testPaths)
    ? (o.testPaths as unknown[]).filter((p): p is string => typeof p === 'string')
    : []
  const report: RunnerReproductionReport = {
    status,
    command: o.command,
    testPaths,
    attempts: typeof o.attempts === 'number' ? o.attempts : 1,
    maxAttempts: typeof o.maxAttempts === 'number' ? o.maxAttempts : 1,
  }
  if (typeof o.omittedTestPaths === 'number') report.omittedTestPaths = o.omittedTestPaths
  const base = coerceReproductionPhase(o.base)
  if (base) report.base = base
  const final = coerceReproductionPhase(o.final)
  if (final) report.final = final
  if (typeof o.reason === 'string') report.reason = o.reason
  if (typeof o.alternativeVerification === 'string') {
    report.alternativeVerification = o.alternativeVerification
  }
  if (typeof o.note === 'string') report.note = o.note
  if (typeof o.at === 'number') report.at = o.at
  return report
}

/** Coerce one tree's phase outcome; undefined for anything without a usable exit code. */
function coerceReproductionPhase(raw: unknown): RunnerReproductionPhase | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const o = raw as Record<string, unknown>
  if (typeof o.exitCode !== 'number') return undefined
  return {
    exitCode: o.exitCode,
    passed: o.passed === true,
    ...(typeof o.outputTail === 'string' ? { outputTail: o.outputTail } : {}),
    ...(typeof o.durationMs === 'number' ? { durationMs: o.durationMs } : {}),
    ...(o.timedOut === true ? { timedOut: true } : {}),
    ...(o.setupFailed === true ? { setupFailed: true } : {}),
  }
}

/**
 * Coerce a scheduler's pre-PR `validationReport` envelope into the canonical
 * {@link RunnerValidationReport}, keeping only well-formed per-command outcomes. Returns
 * undefined for anything that isn't a report-shaped object, so a malformed/absent envelope
 * injects nothing (and the run behaves as if the service configured no checks — which, for a
 * pool that doesn't proxy the field, it effectively did). Mirrors the executor-harness's shape.
 */
function coerceValidationReport(raw: unknown): RunnerValidationReport | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const o = raw as Record<string, unknown>
  if (!Array.isArray(o.outcomes)) return undefined
  const outcomes = (o.outcomes as unknown[])
    .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
    .filter((x) => typeof x.label === 'string' && typeof x.exitCode === 'number')
    .map((x) => ({
      label: x.label as string,
      command: typeof x.command === 'string' ? x.command : '',
      exitCode: x.exitCode as number,
      passed: x.passed === true,
      ...(typeof x.outputTail === 'string' ? { outputTail: x.outputTail } : {}),
      ...(typeof x.durationMs === 'number' ? { durationMs: x.durationMs } : {}),
      ...(x.timedOut === true ? { timedOut: true } : {}),
    }))
  return {
    passed: o.passed === true,
    attempts: typeof o.attempts === 'number' ? o.attempts : 1,
    maxAttempts: typeof o.maxAttempts === 'number' ? o.maxAttempts : outcomes.length > 0 ? 1 : 0,
    outcomes,
    ...(typeof o.at === 'number' ? { at: o.at } : {}),
  }
}

/**
 * Coerce a scheduler's `result` envelope into the canonical {@link RunnerJobResult},
 * picking only the known fields by type. The scalars/booleans are type-guarded; the
 * single structured channel `custom` is passed through verbatim for the engine to
 * strictly validate. Anything unexpected is dropped, so a malformed envelope can never
 * inject junk into the run result.
 *
 * `custom` is the channel the manifest-driven `agent` kinds return their structured doc
 * on (blueprints / spec-writer / merger / on-call / tester); `toRunResult` coerces it
 * backend-side. Dropping it here would silently lose those products on a runner-pool
 * backend while the Cloudflare/local transports (which return the harness view verbatim)
 * keep them — a facade-parity divergence.
 */
function coerceRunnerResult(raw: unknown): Partial<RunnerJobResult> {
  if (typeof raw !== 'object' || raw === null) return {}
  const o = raw as Record<string, unknown>
  const out: Partial<RunnerJobResult> = {}
  const STRINGS = ['prUrl', 'branch', 'summary', 'error', 'defaultBranch'] as const
  for (const k of STRINGS) {
    if (typeof o[k] === 'string') out[k] = o[k] as string
  }
  if (typeof o.pushed === 'boolean') out.pushed = o.pushed
  // Multi-repo run's peer PRs (service-connections phase 3): keep only well-formed entries
  // (a repo + prUrl + branch string), passing the optional frameId through. Absent for a
  // single-repo run — so a pool proxying the executor-harness verbatim carries them intact.
  if (Array.isArray(o.peerPullRequests)) {
    const peers = (o.peerPullRequests as unknown[])
      .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
      .filter(
        (x) =>
          typeof x.repo === 'string' && typeof x.prUrl === 'string' && typeof x.branch === 'string',
      )
      .map((x) => ({
        repo: x.repo as string,
        prUrl: x.prUrl as string,
        branch: x.branch as string,
        ...(typeof x.frameId === 'string' ? { frameId: x.frameId } : {}),
      }))
    if (peers.length) out.peerPullRequests = peers
  }
  // The single structured work-product channel (carried as `unknown` on the port — the
  // engine validates). `custom` is what every manifest-driven `agent` kind returns its
  // doc on; it MUST pass through or the engine never coerces the doc.
  if (o.custom !== undefined) out.custom = o.custom
  const usage = o.usage
  if (
    typeof usage === 'object' &&
    usage !== null &&
    typeof (usage as Record<string, unknown>).inputTokens === 'number' &&
    typeof (usage as Record<string, unknown>).outputTokens === 'number'
  ) {
    out.usage = {
      inputTokens: (usage as { inputTokens: number }).inputTokens,
      outputTokens: (usage as { outputTokens: number }).outputTokens,
    }
  }
  // A subscription harness's per-call telemetry (Claude Code / Codex, whose traffic bypasses
  // the LLM proxy). A pool proxying the executor-harness verbatim carries these in its result
  // envelope; dropping them here would silently lose all `llm_call_metrics` rows on a
  // pool-backed run while the Cloudflare/local transports (which return the harness view
  // verbatim) record them — a facade-parity divergence.
  const callMetrics = coerceCallMetrics(o.callMetrics)
  if (callMetrics.length) out.callMetrics = callMetrics
  // The agent's effort self-assessment (how hard the work was, what reduced its effectiveness,
  // the obstacles). A pool proxying the executor-harness verbatim carries it in its result
  // envelope; keep it so a pool-backed run surfaces effort in run details exactly like the
  // Cloudflare/local transports (which return the harness view verbatim).
  const effortReport = coerceEffortReport(o.effortReport)
  if (effortReport) out.effortReport = effortReport
  // The pre-PR validation report: on a passing run it is the captured proof the checkout was
  // green before the PR opened; on a failed one it is the evidence behind the failure. Dropping
  // it here would leave a pool-backed run with a bare "validation failed" and no output, while
  // the Cloudflare/local transports (which return the harness view verbatim) show every command.
  const validationReport = coerceValidationReport(o.validationReport)
  if (validationReport) out.validationReport = validationReport
  // The bugfix reproduction proof. Dropping it here would leave a pool-backed bugfix PR with no
  // reproduction section at all — indistinguishable from a run that never declared one — while
  // the Cloudflare/local transports (which return the harness view verbatim) publish the verdict.
  const reproductionReport = coerceReproductionReport(o.reproductionReport)
  if (reproductionReport) out.reproductionReport = reproductionReport
  return out
}

/**
 * Coerce a scheduler's `effortReport` envelope into the canonical {@link RunnerJobResult.effortReport}
 * shape, defaulting `difficulty` and keeping only well-formed prose/obstacle fields. Returns
 * undefined for anything that isn't an object, so a malformed/absent envelope injects nothing.
 * Mirrors the executor-harness's own `coerceEffort`.
 */
function coerceEffortReport(raw: unknown): RunnerJobResult['effortReport'] | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const o = raw as Record<string, unknown>
  const hasFiniteDifficulty = typeof o.difficulty === 'number' && Number.isFinite(o.difficulty)
  const difficulty = hasFiniteDifficulty
    ? Math.min(10, Math.max(1, Math.round(o.difficulty as number)))
    : 5
  const report: NonNullable<RunnerJobResult['effortReport']> = { difficulty }
  if (typeof o.summary === 'string' && o.summary.trim()) report.summary = o.summary.trim()
  if (typeof o.reducedEffectiveness === 'string' && o.reducedEffectiveness.trim()) {
    report.reducedEffectiveness = o.reducedEffectiveness.trim()
  }
  if (Array.isArray(o.obstacles)) {
    const obstacles = o.obstacles.filter(
      (x): x is string => typeof x === 'string' && x.trim() !== '',
    )
    if (obstacles.length) report.obstacles = obstacles
  }
  // Mirror the harness's `coerceEffort` drop rule: an envelope carrying only a DEFAULTED difficulty
  // (no real difficulty, prose, or obstacles) says nothing — drop it so a pool-backed run doesn't
  // surface a bare "5/10, no detail" card that the Cloudflare/local path suppresses (facade parity).
  if (
    !hasFiniteDifficulty &&
    report.summary === undefined &&
    report.reducedEffectiveness === undefined &&
    report.obstacles === undefined
  ) {
    return undefined
  }
  return report
}

/**
 * Coerce a scheduler's `callMetrics` array into the canonical {@link HarnessCallMetric}
 * shape, keeping only well-formed entries (the required string/number fields), so a
 * malformed envelope can never inject junk into the telemetry sink. Mirrors the harness's
 * producer field-for-field; a missing optional `model` is passed through when present.
 *
 * The two CACHE-CLASS counts are read leniently (absent ⇒ 0) while every other field stays
 * strict, because a runner pool runs whatever harness IMAGE its workspace pinned — a version
 * this backend does not control. Requiring them would make an image predating the fresh/read/
 * write split fail every entry, i.e. drop ALL of that pool's `llm_call_metrics` silently and
 * report the run as having made zero model calls. Degrading to "no cache breakdown known" keeps
 * the call, the tokens and the prompt/response bodies, and loses only the split the older image
 * genuinely never measured — which is the same answer it gave before the field existed.
 */
function coerceCallMetrics(raw: unknown): HarnessCallMetric[] {
  if (!Array.isArray(raw)) return []
  const out: HarnessCallMetric[] = []
  const count = (value: unknown): number => (typeof value === 'number' ? value : 0)
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const e = entry as Record<string, unknown>
    if (
      typeof e.promptText !== 'string' ||
      typeof e.responseText !== 'string' ||
      typeof e.reasoningText !== 'string' ||
      typeof e.messageCount !== 'number' ||
      typeof e.inputTokens !== 'number' ||
      typeof e.outputTokens !== 'number'
    ) {
      continue
    }
    out.push({
      ...(typeof e.model === 'string' ? { model: e.model } : {}),
      promptText: e.promptText,
      messageCount: e.messageCount,
      responseText: e.responseText,
      reasoningText: e.reasoningText,
      inputTokens: e.inputTokens,
      cacheReadTokens: count(e.cacheReadTokens),
      cacheWriteTokens: count(e.cacheWriteTokens),
      outputTokens: e.outputTokens,
      finishReason: typeof e.finishReason === 'string' ? e.finishReason : null,
      // The harness's job-scoped sequence number. It MUST survive coercion: it is what keeps a
      // call's recorded row id identical across the live poll drain and the terminal list, so
      // dropping it here would make a pool-backed run store every streamed call twice.
      ...(typeof e.seq === 'number' ? { seq: e.seq } : {}),
      // The run phase that spent the call. Passed through as the harness reported it and
      // normalised at the recorder (kernel's `normalizeCallPhase`), so this boundary neither
      // invents a phase nor has to know the vocabulary — a pool on a newer image reporting a
      // phase this backend predates is stored verbatim rather than coerced away.
      ...(typeof e.phase === 'string' ? { phase: e.phase } : {}),
    })
  }
  return out
}
