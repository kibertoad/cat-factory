import type {
  ConnectionTestResult,
  EnvironmentAccessHandle,
  EnvironmentHandle,
  EnvironmentManifest,
  EnvironmentStatus,
  ProviderConfigField,
} from '@cat-factory/kernel'
import type { EnvironmentRecord, UrlSafetyPolicy } from '@cat-factory/kernel'
import {
  getErrorMessage,
  isBlockedPrivateHost,
  STRICT_URL_SAFETY_POLICY,
  ValidationError,
} from '@cat-factory/kernel'

// Pure helpers for the ephemeral-environment integration: SSRF validation of the
// URLs we fetch/expose, `{{var}}` interpolation over a bounded scope, dot-path
// extraction from an arbitrary self-rolled response, status mapping and expiry
// coercion. Keeping these pure makes the generic provider deterministic and
// testable without a live management API.

/** The agent kind that triggers deterministic provisioning. */
export const DEPLOYER_AGENT_KIND = 'deployer'
/** Board category for environment blocks (a deployer pipeline typically runs here). */
export const ENVIRONMENT_BLOCK_TYPE = 'environment'

/**
 * Whether a pipeline step should provision an environment deterministically.
 * Keyed strictly on the `deployer` agent kind so that other steps in a pipeline
 * on an `environment` block (e.g. a following `tester`) still run normally.
 */
export function isDeployStep(agentKind: string): boolean {
  return agentKind === DEPLOYER_AGENT_KIND
}

/**
 * Whether `host` is exempt from the private/internal-host block under `policy`.
 * An allow-list entry matches the hostname case-insensitively, either exactly or as a
 * dot suffix when it begins with `.` (`.internal` matches `a.b.internal`).
 */
function hostExempt(host: string, policy: UrlSafetyPolicy): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '')
  return policy.allowHosts.some((entry) => {
    const e = entry.toLowerCase()
    return e.startsWith('.') ? h === e.slice(1) || h.endsWith(e) : h === e
  })
}

/**
 * Validate a URL before it is stored, fetched, or exposed. The default policy
 * (STRICT_URL_SAFETY_POLICY) requires `https` and rejects internal/private hosts; a
 * trusted operator-installed adapter can pass a widened policy to permit specific
 * schemes/hosts (e.g. an internal env platform on a private/VPN host). Embedded
 * credentials are forbidden regardless of policy. Parsed by hand (no `URL` global) so
 * this stays in the platform-agnostic core.
 */
export function assertSafeEnvironmentUrl(
  url: string,
  label = 'URL',
  policy: UrlSafetyPolicy = STRICT_URL_SAFETY_POLICY,
): void {
  const invalid = () => new ValidationError(`Environment ${label} is not a valid URL: '${url}'`)
  const match = url.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)/)
  if (!match) throw invalid()

  if (!policy.schemes.includes(match[1]!.toLowerCase())) {
    const allowed = policy.schemes.join('/') || '(none)'
    throw new ValidationError(`Environment ${label} must use ${allowed}`)
  }
  const authority = match[2]!
  if (authority.includes('@')) {
    throw new ValidationError(`Environment ${label} must not contain credentials`)
  }
  let host: string
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']')
    if (end === -1) throw invalid()
    host = authority.slice(1, end)
  } else {
    host = authority.split(':')[0]!
  }
  if (host === '') throw invalid()
  if (!hostExempt(host, policy) && isBlockedPrivateHost(host)) {
    throw new ValidationError(`Environment ${label} must be a public host`)
  }
}

/** Validate every URL a manifest will fetch (defence against SSRF). */
export function assertManifestUrlsSafe(
  manifest: EnvironmentManifest,
  policy: UrlSafetyPolicy,
): void {
  assertSafeEnvironmentUrl(manifest.baseUrl, 'base URL', policy)
  if (manifest.auth.type === 'oauth2_client_credentials') {
    assertSafeEnvironmentUrl(manifest.auth.tokenUrl, 'OAuth token URL', policy)
  }
}

/** Collect every secret key a manifest's auth scheme references. */
export function referencedSecretKeys(manifest: EnvironmentManifest): string[] {
  const auth = manifest.auth
  switch (auth.type) {
    case 'none':
      return []
    case 'api_key':
    case 'bearer':
      return [auth.secretRef.key]
    case 'basic':
      return [auth.usernameSecretRef.key, auth.passwordSecretRef.key]
    case 'oauth2_client_credentials':
      return [auth.clientIdSecretRef.key, auth.clientSecretSecretRef.key]
    case 'custom_headers':
      return auth.headers.map((h) => h.secretRef.key)
  }
}

/**
 * Stringify a manifest's opaque `providerConfig` bag (`Record<string, unknown>`) into
 * the `Record<string, string>` a native adapter receives. The bag can carry nested
 * values (objects/arrays — see `providerDescriptorSchema.manifestTemplate`), so a plain
 * `String(v)` would mangle them into `[object Object]` / comma-joined garbage; serialize
 * non-primitive values as JSON instead so the provider sees a faithful representation.
 */
export function stringifyProviderConfig(
  config: Record<string, unknown> | undefined,
): Record<string, string> | undefined {
  if (!config) return undefined
  return Object.fromEntries(
    Object.entries(config).map(([k, v]) => [
      k,
      v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v),
    ]),
  )
}

/**
 * Render a manifest's referenced secret keys as password config fields, so the
 * manifest editor can show which secrets a connection still needs. Shared by the
 * generic environment + runner-pool providers' `describeConfig`.
 */
export function configFieldsFromSecretKeys(keys: string[]): ProviderConfigField[] {
  return keys.map((key) => ({ key, label: key, secret: true, required: true }))
}

/**
 * The config-field keys a provider still needs the org to supply: fields that are
 * `required`, carry no `default` (so there's no fallback), and have no value stored
 * yet. `storedKeys` is every key already persisted for the workspace — the secret
 * bundle keys plus, for a native adapter, its manifest `providerConfig` keys. Empty
 * ⇒ fully configured. This is the single source of truth behind
 * `ProviderDescriptor.missingRequired` (the unconfigured-provider banner) and the
 * shared `describeProvider` of both connection services.
 */
export function missingRequiredConfigKeys(
  fields: ProviderConfigField[],
  storedKeys: Iterable<string>,
): string[] {
  const present = new Set(storedKeys)
  return fields
    .filter((f) => f.required === true && f.default === undefined && !present.has(f.key))
    .map((f) => f.key)
}

/**
 * A minimal, side-effect-free connection probe: an authed GET against the pool/env
 * management `baseUrl`. Any HTTP response means the host is reachable; a 401/403
 * means the credentials were rejected. Never throws — a network failure is reported
 * as `{ ok:false }`. Shared by the generic providers' `testConnection`.
 */
export async function probeConnection(
  baseUrl: string,
  headers: Record<string, string>,
  policy: UrlSafetyPolicy = STRICT_URL_SAFETY_POLICY,
  timeoutMs = 10_000,
): Promise<ConnectionTestResult> {
  try {
    assertSafeEnvironmentUrl(baseUrl, 'base URL', policy)
  } catch (err) {
    return { ok: false, message: getErrorMessage(err) }
  }
  try {
    const res = await fetch(baseUrl, {
      method: 'GET',
      headers: { accept: 'application/json', ...headers },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (res.status === 401 || res.status === 403) {
      return { ok: false, message: `Credentials rejected (HTTP ${res.status})` }
    }
    return { ok: true, message: `Reachable (HTTP ${res.status})` }
  } catch (err) {
    return { ok: false, message: getErrorMessage(err) }
  }
}

/** Variables available to manifest templates, in a bounded namespace. */
export interface InterpolationScope {
  input: Record<string, string>
  provision: Record<string, string>
}

/**
 * Replace `{{ namespace.key }}` placeholders from the given scope. Unknown
 * namespaces and missing keys resolve to an empty string, so a template can
 * never reference arbitrary host state.
 */
export function interpolateTemplate(template: string, scope: InterpolationScope): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_match, expr: string) => {
    const dot = expr.indexOf('.')
    if (dot === -1) return ''
    const ns = expr.slice(0, dot)
    const key = expr.slice(dot + 1)
    const bag = ns === 'input' ? scope.input : ns === 'provision' ? scope.provision : undefined
    if (!bag) return ''
    const value = bag[key]
    return value === undefined ? '' : value
  })
}

/** Read a value from parsed JSON by a dot-path (e.g. `data.url`, `items.0.id`). */
export function extractByPath(json: unknown, path: string): unknown {
  if (!path) return undefined
  let current: unknown = json
  for (const segment of path.split('.')) {
    if (current === null || current === undefined) return undefined
    if (typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

/** Extract a scalar as a string, or undefined if absent/non-scalar. */
export function extractString(json: unknown, path: string | undefined): string | undefined {
  if (!path) return undefined
  const value = extractByPath(json, path)
  if (value === null || value === undefined) return undefined
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return undefined
}

/**
 * Map a provider status string onto our lifecycle states using the manifest's
 * `statusMap`. Falls back to `fallback` (caller decides, e.g. 'ready' for a
 * synchronous provisioner with no status polling).
 */
export function mapStatus(
  raw: string | undefined,
  statusMap: { from: string; to: EnvironmentStatus }[] | undefined,
  fallback: EnvironmentStatus,
): EnvironmentStatus {
  if (raw !== undefined && statusMap) {
    const hit = statusMap.find((m) => m.from.toLowerCase() === raw.toLowerCase())
    if (hit) return hit.to
  }
  return fallback
}

/** Project a stored record onto the wire handle, optionally with decrypted access. */
export function recordToHandle(
  record: EnvironmentRecord,
  access?: EnvironmentAccessHandle | null,
): EnvironmentHandle {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    blockId: record.blockId,
    executionId: record.executionId,
    providerId: record.providerId,
    externalId: record.externalId,
    url: record.url,
    status: record.status,
    ...(access ? { access } : {}),
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    lastError: record.lastError,
    provisionType: (record.provisionType ?? null) as EnvironmentHandle['provisionType'],
    engine: (record.engine ?? null) as EnvironmentHandle['engine'],
  }
}

/** Coerce an extracted expiry (epoch-ms number, numeric string, or ISO) to ms. */
export function coerceExpiresAt(value: unknown): number | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (/^\d+$/.test(trimmed)) return Number(trimmed)
    const parsed = Date.parse(trimmed)
    if (!Number.isNaN(parsed)) return parsed
  }
  return null
}
