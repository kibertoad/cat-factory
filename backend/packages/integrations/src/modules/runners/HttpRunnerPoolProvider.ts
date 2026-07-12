import type {
  ConnectionTestResult,
  HarnessCallMetric,
  ProviderConfigField,
  RunnerDispatchRequest,
  RunnerJobResult,
  RunnerJobView,
  RunnerPollRequest,
  RunnerPoolAuthScheme,
  RunnerPoolConnectionTestRequest,
  RunnerPoolManifest,
  RunnerPoolProvider,
  RunnerPoolRequestTemplate,
  SecretResolver,
  UrlSafetyPolicy,
} from '@cat-factory/kernel'
import { STRICT_URL_SAFETY_POLICY } from '@cat-factory/kernel'
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

  async dispatch(req: RunnerDispatchRequest): Promise<void> {
    await this.execute(
      req.manifest,
      req.manifest.dispatch,
      this.scope(req.jobId, req.spec),
      req.resolveSecret,
    )
  }

  async poll(req: RunnerPollRequest): Promise<RunnerJobView> {
    const json = await this.execute(
      req.manifest,
      req.manifest.poll,
      this.scope(req.jobId),
      req.resolveSecret,
    )
    return this.mapJobView(req.manifest, json)
  }

  async release(req: RunnerPollRequest): Promise<void> {
    if (!req.manifest.release) return
    await this.execute(req.manifest, req.manifest.release, this.scope(req.jobId), req.resolveSecret)
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
    const state = runnersLogic.mapJobState(rawStatus, r.statusMap)
    const error = environmentsLogic.extractString(json, r.errorPath)

    const view: RunnerJobView = { state }

    const progress = this.mapProgress(manifest, json)
    if (progress) view.progress = progress

    // Forward-looking follow-up items the Coder streamed since the last poll (drain-on-read),
    // when the manifest maps them. Surfaced on every poll (running or done) so a fast final
    // burst isn't lost. Best-effort: a malformed entry is dropped.
    const followUps = this.mapFollowUps(manifest, json)
    if (followUps && followUps.length > 0) view.followUps = followUps

    // The harness's structured failure cause + extended diagnostic, when the manifest maps
    // them — so a pool that proxies the executor-harness verbatim classifies a failure exactly
    // like a Cloudflare container, instead of degrading to the engine's error-string regex.
    const failureCause = environmentsLogic.extractString(json, r.failureCausePath)
    const detail = environmentsLogic.extractString(json, r.detailPath)
    if (failureCause) view.failureCause = failureCause
    if (detail) view.detail = detail

    if (state === 'failed') {
      view.error = error ?? 'Runner pool reported the job failed'
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
  return out
}

/**
 * Coerce a scheduler's `callMetrics` array into the canonical {@link HarnessCallMetric}
 * shape, keeping only well-formed entries (the required string/number fields), so a
 * malformed envelope can never inject junk into the telemetry sink. Mirrors the harness's
 * producer field-for-field; a missing optional `model` is passed through when present.
 */
function coerceCallMetrics(raw: unknown): HarnessCallMetric[] {
  if (!Array.isArray(raw)) return []
  const out: HarnessCallMetric[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const e = entry as Record<string, unknown>
    if (
      typeof e.promptText !== 'string' ||
      typeof e.responseText !== 'string' ||
      typeof e.reasoningText !== 'string' ||
      typeof e.messageCount !== 'number' ||
      typeof e.inputTokens !== 'number' ||
      typeof e.cachedInputTokens !== 'number' ||
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
      cachedInputTokens: e.cachedInputTokens,
      outputTokens: e.outputTokens,
      finishReason: typeof e.finishReason === 'string' ? e.finishReason : null,
    })
  }
  return out
}
