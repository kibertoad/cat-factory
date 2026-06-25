import type {
  ConnectionTestResult,
  EnvironmentAccessHandle,
  EnvironmentHandle,
  EnvironmentStatus,
  ProviderConfigField,
} from '@cat-factory/kernel'
import type { EnvironmentRecord, UrlSafetyPolicy } from '@cat-factory/kernel'
import { getErrorMessage, STRICT_URL_SAFETY_POLICY, ValidationError } from '@cat-factory/kernel'

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

/** Whether a decoded IPv4 address is loopback / link-local (metadata) / RFC1918. */
function isPrivateV4(parts: [number, number, number, number]): boolean {
  const [a, b] = parts
  if (a === 127 || a === 0 || a === 10) return true
  if (a === 169 && b === 254) return true
  if (a === 192 && b === 168) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  return false
}

/** Parse a plain dotted-decimal IPv4 literal (each octet 0-255), or null. */
function decimalV4(host: string): [number, number, number, number] | null {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return null
  const a = Number(m[1])
  const b = Number(m[2])
  const c = Number(m[3])
  const d = Number(m[4])
  if (a > 255 || b > 255 || c > 255 || d > 255) return null
  return [a, b, c, d]
}

/** Extract the embedded IPv4 of an IPv4-mapped IPv6 literal (`::ffff:…`), or null. */
function mappedV4(host: string): [number, number, number, number] | null {
  // ::ffff:a.b.c.d
  const dotted = host.match(/^::ffff:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (dotted) {
    const a = Number(dotted[1])
    const b = Number(dotted[2])
    const c = Number(dotted[3])
    const d = Number(dotted[4])
    if (a > 255 || b > 255 || c > 255 || d > 255) return null
    return [a, b, c, d]
  }
  // ::ffff:hhhh:hhhh
  const hex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (hex) {
    const hi = parseInt(hex[1] ?? '0', 16)
    const lo = parseInt(hex[2] ?? '0', 16)
    return [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff]
  }
  return null
}

/**
 * Reject hostnames that point at the worker's own network rather than a public
 * host. The generic provider fetches org-supplied URLs (and we surface the
 * provisioned env URL to agents), so an unvalidated URL turns the worker into an
 * SSRF proxy. Host-literal defence-in-depth: blocks loopback, link-local
 * (incl. cloud metadata 169.254.x.x) and the RFC1918 private ranges — including
 * the obfuscated encodings (bare integer, hex/octal octets, IPv4-mapped IPv6)
 * that trivially bypass a naive dotted-decimal match.
 */
function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === '') return true
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host.endsWith('.internal') || host.endsWith('.local')) return true

  // IPv6 literals (contain a colon).
  if (host.includes(':')) {
    if (host === '::1' || host === '::') return true
    if (host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return true
    const mapped = mappedV4(host)
    if (mapped) return isPrivateV4(mapped)
    return false
  }

  // Obfuscated numeric IPv4 forms are never a legitimate public hostname.
  // Bare integer (e.g. 2130706433 === 127.0.0.1).
  if (/^\d+$/.test(host)) return true
  const labels = host.split('.')
  for (const label of labels) {
    if (/^0x[0-9a-f]+$/.test(label)) return true // hex octet (0x7f)
    if (/^0[0-9]+$/.test(label)) return true // octal / leading-zero octet (0177)
  }

  // Standard dotted-decimal IPv4: public addresses pass, private ones blocked.
  const v4 = decimalV4(host)
  if (v4) return isPrivateV4(v4)

  // A purely numeric dotted host that is not a valid public dotted-decimal IPv4
  // is some other IP encoding we cannot vouch for — reject when in doubt.
  if (labels.length > 1 && labels.every((l) => /^\d+$/.test(l))) return true

  return false
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
  if (!hostExempt(host, policy) && isBlockedHost(host)) {
    throw new ValidationError(`Environment ${label} must be a public host`)
  }
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
