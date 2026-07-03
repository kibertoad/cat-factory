import {
  type ConnectionTestResult,
  type EnvironmentAccessHandle,
  type EnvironmentAccessMapping,
  type EnvironmentAuthScheme,
  type EnvironmentConnectionTestRequest,
  type EnvironmentManifest,
  type EnvironmentProvider,
  type EnvironmentRequestTemplate,
  type EnvironmentStatusRequest,
  type EnvironmentTeardownRequest,
  type EnvironmentStatus,
  type ProviderConfigField,
  type ProvisionEnvironmentRequest,
  type ProvisionFields,
  type ProvisionedEnvironment,
  type SecretResolver,
  type UrlSafetyPolicy,
  STRICT_URL_SAFETY_POLICY,
} from '@cat-factory/kernel'
import * as environmentsLogic from './environments.logic.js'
import { referencedSecretKeys } from './environments.logic.js'
import { type MakeHttpError, readCappedText, safeFetch } from '../shared/safe-fetch.js'

// The single generic adapter that interprets ANY environment manifest. There are
// no per-provider presets: an org's self-rolled management API is described as
// HTTP request templates with `{{var}}` interpolation, an auth scheme, and a
// dot-path mapping from its (arbitrary) response onto the canonical handle.
//
// Security: every URL is SSRF-guarded before it is fetched; the per-tenant
// secrets are resolved in-memory via the injected resolver and only ever placed
// in request headers — never logged or echoed in errors (error bodies are
// length-capped and carry no request headers).

const DEFAULT_TIMEOUT_MS = 15_000
const MAX_RESPONSE_CHARS = 200_000
/** Hard cap on the bytes read off any response body (mirrors MAX_RESPONSE_CHARS). */
const MAX_RESPONSE_BYTES = MAX_RESPONSE_CHARS
const USER_AGENT = 'cat-factory'

/** Carries the HTTP status so the API can surface a meaningful (redacted) error. */
export class EnvironmentApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'EnvironmentApiError'
  }
}

/** Redirect/size failures from the shared SSRF-safe fetch surface as this provider's error. */
const makeEnvError: MakeHttpError = (status, message) =>
  new EnvironmentApiError(status, `Environment provider ${message.toLowerCase()}`)

export interface HttpEnvironmentProviderOptions {
  defaultTimeoutMs?: number
  /** URL/host safety policy; defaults to strict (https-only, no private hosts). */
  urlPolicy?: UrlSafetyPolicy
}

export class HttpEnvironmentProvider implements EnvironmentProvider {
  private readonly defaultTimeoutMs: number
  private readonly urlPolicy: UrlSafetyPolicy
  /** Per-isolate OAuth token cache, keyed by token URL + client id. */
  private readonly oauthCache = new Map<string, { token: string; expiresAt: number }>()

  constructor(options: HttpEnvironmentProviderOptions = {}) {
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS
    this.urlPolicy = options.urlPolicy ?? STRICT_URL_SAFETY_POLICY
  }

  async provision(req: ProvisionEnvironmentRequest): Promise<ProvisionedEnvironment> {
    const json = await this.execute(
      req.manifest,
      req.manifest.provision,
      {
        input: req.inputs,
        provision: {},
      },
      req.resolveSecret,
    )
    // A successful provision call defaults to 'ready' unless the manifest maps a
    // status string (e.g. an async provisioner returning 'pending').
    return this.mapResponse(req.manifest, json, 'ready')
  }

  async status(req: EnvironmentStatusRequest): Promise<ProvisionedEnvironment> {
    if (!req.manifest.status) {
      // No status endpoint declared: treat the environment as ready and echo what
      // we captured at provision time.
      return {
        externalId: req.externalId,
        url: req.provisionFields.url ?? null,
        status: 'ready',
        expiresAt: null,
        access: null,
        fields: req.provisionFields,
      }
    }
    const json = await this.execute(
      req.manifest,
      req.manifest.status,
      {
        input: {},
        provision: req.provisionFields,
      },
      req.resolveSecret,
    )
    const mapped = this.mapResponse(req.manifest, json, 'ready')
    return { ...mapped, externalId: mapped.externalId ?? req.externalId }
  }

  async teardown(req: EnvironmentTeardownRequest): Promise<{ status: EnvironmentStatus }> {
    if (req.manifest.teardown) {
      await this.execute(
        req.manifest,
        req.manifest.teardown,
        {
          input: {},
          provision: req.provisionFields,
        },
        req.resolveSecret,
      )
    }
    return { status: 'torn_down' }
  }

  /** A manifest-driven provider: the config IS the manifest, so describe its secret keys. */
  describeConfig(manifest?: EnvironmentManifest): ProviderConfigField[] {
    if (!manifest) return []
    return environmentsLogic.configFieldsFromSecretKeys(referencedSecretKeys(manifest))
  }

  /** Probe the management API with the candidate manifest's auth (nothing provisioned). */
  async testConnection(req: EnvironmentConnectionTestRequest): Promise<ConnectionTestResult> {
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

  private async execute(
    manifest: EnvironmentManifest,
    template: EnvironmentRequestTemplate,
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

    const res = await safeFetch(
      url,
      {
        method: template.method,
        headers,
        body,
        signal: AbortSignal.timeout(template.timeoutMs ?? this.defaultTimeoutMs),
      },
      (u) => environmentsLogic.assertSafeEnvironmentUrl(u, 'request URL', this.urlPolicy),
      makeEnvError,
    )

    if (!res.ok) {
      const errText = await readCappedText(res, MAX_RESPONSE_BYTES, makeEnvError, false).catch(
        () => '',
      )
      throw new EnvironmentApiError(
        res.status,
        `Environment provider ${template.method} → ${res.status}: ${errText.slice(0, 300)}`,
      )
    }
    const text = await readCappedText(res, MAX_RESPONSE_BYTES, makeEnvError)
    if (!text) return {}
    try {
      return JSON.parse(text)
    } catch {
      // Non-JSON responses leave the mapping to resolve to nulls.
      return {}
    }
  }

  private buildUrl(
    baseUrl: string,
    template: EnvironmentRequestTemplate,
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
    auth: EnvironmentAuthScheme,
    resolveSecret: SecretResolver,
  ): Promise<Record<string, string>> {
    const secret = (key: string): string => {
      const value = resolveSecret(key)
      if (value === undefined) throw new EnvironmentApiError(500, `Missing secret '${key}'`)
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
    auth: Extract<EnvironmentAuthScheme, { type: 'oauth2_client_credentials' }>,
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
      makeEnvError,
    )
    if (!res.ok) {
      const text = await readCappedText(res, MAX_RESPONSE_BYTES, makeEnvError, false).catch(
        () => '',
      )
      throw new EnvironmentApiError(
        res.status,
        `OAuth token request → ${res.status}: ${text.slice(0, 200)}`,
      )
    }
    const tokenText = await readCappedText(res, MAX_RESPONSE_BYTES, makeEnvError)
    const json = (() => {
      try {
        return JSON.parse(tokenText) as { access_token?: string; expires_in?: number }
      } catch {
        return null
      }
    })()
    if (!json?.access_token) {
      throw new EnvironmentApiError(502, 'OAuth token response missing access_token')
    }
    const ttlMs = (typeof json.expires_in === 'number' ? json.expires_in : 300) * 1000
    this.oauthCache.set(cacheKey, { token: json.access_token, expiresAt: Date.now() + ttlMs })
    return json.access_token
  }

  private mapResponse(
    manifest: EnvironmentManifest,
    json: unknown,
    fallbackStatus: EnvironmentStatus,
  ): ProvisionedEnvironment {
    const r = manifest.response
    const externalId = environmentsLogic.extractString(json, r.externalIdPath) ?? null
    const url = environmentsLogic.extractString(json, r.urlPath) ?? null
    const rawStatus = environmentsLogic.extractString(json, r.statusPath)
    const status = environmentsLogic.mapStatus(rawStatus, r.statusMap, fallbackStatus)
    const expiresAt = r.expiresAtPath
      ? environmentsLogic.coerceExpiresAt(environmentsLogic.extractByPath(json, r.expiresAtPath))
      : null

    const fields: ProvisionFields = {}
    if (externalId) fields.externalId = externalId
    if (url) fields.url = url

    return {
      externalId,
      url,
      status,
      expiresAt,
      access: this.mapAccess(r.access, json),
      fields,
    }
  }

  private mapAccess(
    mapping: EnvironmentAccessMapping | undefined,
    json: unknown,
  ): EnvironmentAccessHandle | null {
    if (!mapping) return null
    const access: EnvironmentAccessHandle = { scheme: mapping.scheme }
    if (mapping.scheme === 'bearer') {
      access.token = environmentsLogic.extractString(json, mapping.tokenPath)
    } else if (mapping.scheme === 'basic') {
      access.username = environmentsLogic.extractString(json, mapping.usernamePath)
      access.password = environmentsLogic.extractString(json, mapping.passwordPath)
    } else if (mapping.scheme === 'custom_header') {
      access.headerName = mapping.headerName
      access.headerValue = environmentsLogic.extractString(json, mapping.headerValuePath)
    }
    return access
  }
}
