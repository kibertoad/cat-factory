import {
  environmentsLogic,
  runnersLogic,
  type RunnerDispatchRequest,
  type RunnerJobView,
  type RunnerPollRequest,
  type RunnerPoolAuthScheme,
  type RunnerPoolManifest,
  type RunnerPoolProvider,
  type RunnerPoolRequestTemplate,
  type SecretResolver,
} from '@cat-factory/core'

// The single generic adapter that interprets ANY runner-pool manifest. There are
// no per-org presets: an org's pool scheduler API is described as HTTP request
// templates with `{{var}}` interpolation, an auth scheme, and a dot-path mapping
// from its (arbitrary) status response onto the canonical harness job view. This
// is the runner-pool sibling of HttpEnvironmentProvider and reuses the same
// generic primitives (interpolation, dot-path extraction, the SSRF guard).
//
// Security: every URL is SSRF-guarded before it is fetched; the per-tenant
// scheduler secrets are resolved in-memory via the injected resolver and only
// ever placed in request headers — never logged or echoed in errors (error
// bodies are length-capped and carry no request headers). The per-job GitHub +
// LLM-proxy tokens travel inside the interpolated dispatch body (the runner needs
// them) and are likewise never logged.

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_RESPONSE_CHARS = 200_000
const USER_AGENT = 'cat-factory'

/** Carries the HTTP status so callers can surface a meaningful (redacted) error. */
export class RunnerPoolApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'RunnerPoolApiError'
  }
}

export interface HttpRunnerPoolProviderOptions {
  defaultTimeoutMs?: number
}

export class HttpRunnerPoolProvider implements RunnerPoolProvider {
  private readonly defaultTimeoutMs: number
  /** Per-isolate OAuth token cache, keyed by token URL + client id. */
  private readonly oauthCache = new Map<string, { token: string; expiresAt: number }>()

  constructor(options: HttpRunnerPoolProviderOptions = {}) {
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS
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

  // --- internals ----------------------------------------------------------

  /**
   * The bounded interpolation scope a template sees: `{{input.jobId}}` (the id the
   * pool is keyed on) and `{{input.job}}` (the full harness job spec as JSON, so a
   * body template can forward it verbatim). Reuses the environments interpolation
   * machinery; the second (`provision`) namespace is unused by runner manifests.
   */
  private scope(
    jobId: string,
    spec?: Record<string, unknown>,
  ): environmentsLogic.InterpolationScope {
    return {
      input: { jobId, job: spec ? JSON.stringify(spec) : '' },
      provision: {},
    }
  }

  private async execute(
    manifest: RunnerPoolManifest,
    template: RunnerPoolRequestTemplate,
    scope: environmentsLogic.InterpolationScope,
    resolveSecret: SecretResolver,
  ): Promise<unknown> {
    const url = this.buildUrl(manifest.baseUrl, template, scope)
    environmentsLogic.assertSafeEnvironmentUrl(url, 'request URL')

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

    const res = await fetch(url, {
      method: template.method,
      headers,
      body,
      signal: AbortSignal.timeout(template.timeoutMs ?? this.defaultTimeoutMs),
    })

    const text = await res.text().catch(() => '')
    if (!res.ok) {
      throw new RunnerPoolApiError(
        res.status,
        `Runner pool ${template.method} → ${res.status}: ${text.slice(0, 300)}`,
      )
    }
    if (text.length > MAX_RESPONSE_CHARS) {
      throw new RunnerPoolApiError(502, 'Runner pool response too large')
    }
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

    environmentsLogic.assertSafeEnvironmentUrl(auth.tokenUrl, 'OAuth token URL')
    const form = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: secret(auth.clientSecretSecretRef.key),
    })
    if (auth.scope) form.set('scope', auth.scope)
    if (auth.audience) form.set('audience', auth.audience)

    const res = await fetch(auth.tokenUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
        'user-agent': USER_AGENT,
      },
      body: form.toString(),
      signal: AbortSignal.timeout(this.defaultTimeoutMs),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new RunnerPoolApiError(
        res.status,
        `OAuth token request → ${res.status}: ${text.slice(0, 200)}`,
      )
    }
    const json = (await res.json().catch(() => null)) as {
      access_token?: string
      expires_in?: number
    } | null
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

    if (state === 'failed') {
      view.error = error ?? 'Runner pool reported the job failed'
      return view
    }

    if (state === 'done') {
      const prUrl = environmentsLogic.extractString(json, r.prUrlPath)
      const branch = environmentsLogic.extractString(json, r.branchPath)
      const summary = environmentsLogic.extractString(json, r.summaryPath)
      const result: NonNullable<RunnerJobView['result']> = {}
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
}
