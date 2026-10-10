// ---------------------------------------------------------------------------
// SSRF guard for local-runner base URLs. A runner lives on the user's OWN machine
// (or LAN), so we forward requests to a user-supplied base URL server-side (both the
// "Test connection" probe and the run-time LLM proxy). The usual "block private IPs"
// mitigation is backwards here: loopback is exactly the intended target, so we ALLOW
// only loopback hosts and reject everything else. Private-LAN reach (RFC1918 / ULA /
// mDNS `.local`) is an OPERATOR OPT-IN (`LOCAL_MODELS_ALLOW_LAN=true`), not the
// baseline: on a multi-tenant Node deployment the LAN allow-list is itself an
// internal-network SSRF grant (admin panels, Consul/etcd, other tenants' services),
// no redirect trick needed. Single-tenant local mode defaults the opt-in ON, since a
// developer's own LAN (an LM Studio box, a homelab Ollama host) is the intended
// reach there. The cloud-metadata endpoint (169.254.169.254 / fe80::) is denied under
// every policy. Public/remote runners are not supported by design.
// ---------------------------------------------------------------------------

import type { LocalRunnerUrlReason } from '@cat-factory/contracts'
import { decodeIpv4, isCloudMetadataHost, isPrivateV4 } from '@cat-factory/kernel'

/** A refused runner URL: the machine-readable cause plus the operator-facing detail. */
export interface LocalRunnerUrlRefusal {
  reason: LocalRunnerUrlReason
  message: string
}

/** The host policy a deployment applies to local-runner URLs. */
export interface LocalRunnerUrlPolicy {
  /**
   * Permit RFC1918/ULA/mDNS private-LAN hosts in addition to loopback. OFF by default,
   * so an un-threaded call site fails safe: only an operator who understands the
   * internal-network exposure turns it on (`LOCAL_MODELS_ALLOW_LAN=true`; local mode
   * defaults it on, being single-tenant by definition).
   */
  allowPrivateLan?: boolean
}

/** Classify a decoded IPv4 under the policy: loopback always, RFC1918 only on opt-in. */
function isAllowedRunnerV4(
  v4: [number, number, number, number],
  allowPrivateLan: boolean,
): boolean {
  if (v4[0] === 127) return true // loopback 127/8
  // `isPrivateV4` accepts 10/8, 172.16/12, 192.168/16, plus 0.* and 169.254.* which we
  // exclude (0.0.0.0/8 unspecified; the metadata range is denied before we get here).
  return allowPrivateLan && v4[0] !== 0 && isPrivateV4(v4)
}

/** Whether a hostname (no port) is a runner host the policy lets us forward to. */
function isAllowedRunnerHost(host: string, allowPrivateLan: boolean): boolean {
  const h = host.toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (h === '') return false
  // Cloud-metadata / link-local endpoints (169.254.0.0/16, metadata.google.internal,
  // fd00:ec2::254, …) are the primary SSRF target. Deny them FIRST — some (the whole
  // 169.254/16 range) would otherwise look "private", across every obfuscated encoding.
  if (isCloudMetadataHost(h)) return false

  // Exactly `localhost`, never a `*.localhost` subdomain: that suffix is not delegated in
  // the public root, but the NAME is still handed to the deployment's resolver, and in a
  // container with search domains (`ndots`) a 2-label name like `evil.com.localhost` is tried
  // with those suffixes first, so a wildcard answer sends the fetch off-loopback. It is also
  // the only allowed form that is not a literal, hence the only one with a DNS-rebinding
  // window. No default needs it (`LOCAL_RUNNER_DEFAULTS` are all `localhost`).
  if (h === 'localhost') return true
  // mDNS `.local` names resolve only on the LAN: a LAN-tier grant, not a loopback one.
  if (allowPrivateLan && h.endsWith('.local')) return true

  // IPv6 literals (URL.hostname keeps them bracketless here → they contain a colon).
  // Gating the ULA prefix test behind this colon check is what stops a registrable DNS
  // name like `fc2.com` / `fd-x.evil.com` from masquerading as a private fc00::/7 host.
  if (h.includes(':')) {
    if (h === '::1') return true // loopback
    if (allowPrivateLan && (h.startsWith('fc') || h.startsWith('fd'))) return true // ULA fc00::/7
    // IPv4-mapped IPv6 (e.g. `::ffff:10.0.0.1`) → classify by the embedded IPv4.
    const mapped = decodeIpv4(h)
    if (mapped) return isAllowedRunnerV4(mapped, allowPrivateLan)
    // fe80::/10 (link-local), :: (unspecified), and global addresses → denied.
    return false
  }

  // IPv4 in any form the WHATWG URL parser may leave us (it canonicalises hex/octal/
  // integer hosts to dotted-decimal before we see them; `decodeIpv4` covers the rest
  // defensively).
  const v4 = decodeIpv4(h)
  if (v4) return isAllowedRunnerV4(v4, allowPrivateLan)

  // Public hostname / anything unrecognised → denied.
  return false
}

/** Whether the URL as WRITTEN carries a `.` or `..` path segment. */
function hasDotSegment(rawUrl: string): boolean {
  const afterScheme = rawUrl.slice(rawUrl.indexOf('://') + 3)
  const slash = afterScheme.indexOf('/')
  if (slash < 0) return false
  return /(^|\/)\.\.?(\/|$)/.test(afterScheme.slice(slash))
}

/**
 * Validate a local-runner base URL under `policy`. Returns the refusal (machine-readable
 * `reason` + operator-facing `message`) when the URL is malformed, carries a
 * request-shaping suffix, or points at a host the policy denies; `null` when acceptable.
 * Used by the service at the write boundary, by the "Test connection" probe, by
 * {@link runnerRequestUrl} and per redirect hop by {@link fetchLocalRunner}.
 */
export function localRunnerUrlRefusal(
  rawUrl: string,
  policy?: LocalRunnerUrlPolicy,
): LocalRunnerUrlRefusal | null {
  const allowPrivateLan = policy?.allowPrivateLan ?? false
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return { reason: 'invalid_url', message: 'Enter a valid URL, e.g. http://localhost:11434/v1.' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { reason: 'scheme_not_allowed', message: 'A runner URL must use http or https.' }
  }
  // Embedded credentials (`user:pass@host`) have no legitimate use for a local runner
  // and are a classic way to smuggle an unexpected authority past a naive check.
  if (url.username || url.password) {
    return {
      reason: 'credentials_not_allowed',
      message: 'A runner URL must not contain credentials.',
    }
  }
  // A BASE url is an origin + a path prefix and nothing else. A query string or fragment
  // makes the endpoint suffix we append (`/models`, `/chat/completions`) inert or inert-ish
  // (`…/_search?q=x#` + `/models` requests `/_search?q=x`), which would turn the two
  // fixed-path forwards into an arbitrary-path request against a loopback service. Dot
  // segments are refused for the same reason: they let a stored prefix walk elsewhere.
  if (url.search || url.hash) {
    return {
      reason: 'query_or_fragment_not_allowed',
      message:
        'A runner URL must be a plain base URL: no query string and no "#" fragment ' +
        '(the platform appends the endpoint path itself).',
    }
  }
  // Dot segments are checked on the RAW string, because the URL parser resolves them away
  // before `pathname` is readable. They cannot defeat the appended suffix (it stays last),
  // so this is honesty rather than containment: a stored prefix that silently relocates the
  // request is not the prefix the operator typed.
  if (hasDotSegment(rawUrl)) {
    return {
      reason: 'query_or_fragment_not_allowed',
      message: 'A runner URL must not contain "." or ".." path segments.',
    }
  }
  if (!isAllowedRunnerHost(url.hostname, allowPrivateLan)) {
    return allowPrivateLan
      ? {
          reason: 'host_not_local',
          message:
            'A local runner must live on your own machine or LAN (localhost, *.local, or a ' +
            'private 10./172.16-31./192.168. address). Public or remote hosts are not allowed.',
        }
      : {
          reason: 'host_not_loopback',
          message:
            'A local runner must live on this machine (localhost, 127.x.x.x, or [::1]). ' +
            'Private-LAN runner hosts are disabled on this deployment; an operator can allow ' +
            'them with LOCAL_MODELS_ALLOW_LAN=true.',
        }
  }
  return null
}

/**
 * Compose the URL of one runner ENDPOINT (`/models`, `/chat/completions`) from a stored
 * base URL, validating both ends under `policy`.
 *
 * Every server-side forward goes through here rather than concatenating, because the
 * safety of the two forwards rests on the endpoint path being ours, and a plain template
 * string cannot state that: whatever the base contributes wins whenever it can shape the
 * request (see the query/fragment refusal above). So the composed URL is re-validated and
 * its pathname must still END with the suffix we asked for. A pre-existing row that would
 * defeat the suffix is therefore refused HERE too, not only at the write boundary it was
 * written before.
 */
export function runnerRequestUrl(
  baseUrl: string,
  suffix: `/${string}`,
  policy?: LocalRunnerUrlPolicy,
): { url: string } | { refusal: LocalRunnerUrlRefusal } {
  const refusal = localRunnerUrlRefusal(baseUrl, policy)
  if (refusal) return { refusal }
  const composed = `${baseUrl.replace(/\/+$/, '')}${suffix}`
  const composedRefusal = localRunnerUrlRefusal(composed, policy)
  if (composedRefusal) return { refusal: composedRefusal }
  if (!new URL(composed).pathname.endsWith(suffix)) {
    return {
      refusal: {
        reason: 'query_or_fragment_not_allowed',
        message: 'A runner URL must be a plain base URL the platform can append a path to.',
      },
    }
  }
  return { url: composed }
}

/** Max redirect hops the revalidating fetch will follow before giving up. */
const MAX_LOCAL_RUNNER_REDIRECTS = 5

/**
 * Fetch a local-runner URL, re-validating the SSRF allow-list on EVERY redirect hop.
 *
 * The allow-list permits loopback (and, on opt-in, LAN) hosts, but a permitted runner can
 * still `302` to a denied host, most dangerously the cloud-metadata endpoint
 * (169.254.169.254), and the platform `fetch` would follow it silently. So we drive
 * redirects by hand (`redirect: 'manual'`) and run {@link localRunnerUrlError} against
 * each `Location` before following it, mirroring the environment provider's `safeFetch`.
 * Both server-side callers (the "Test connection" probe and the run-time LLM proxy
 * forward) use this instead of a bare `fetch`, through
 * `LocalModelEndpointService.fetchRunner`, which binds the deployment's policy, so a row
 * persisted while LAN access was enabled is refused at fetch time after an operator
 * narrows the policy, not silently honoured. Throws when a hop fails validation or the
 * redirect chain is too long.
 */
export async function fetchLocalRunner(
  rawUrl: string,
  init: RequestInit,
  doFetch: typeof fetch = fetch,
  policy?: LocalRunnerUrlPolicy,
): Promise<Response> {
  let current = rawUrl
  for (let hop = 0; ; hop++) {
    const err = localRunnerUrlRefusal(current, policy)
    if (err) throw new Error(`Blocked local-runner request: ${err.message}`)
    const res = await doFetch(current, { ...init, redirect: 'manual' })
    if (res.status < 300 || res.status >= 400) return res
    if (hop >= MAX_LOCAL_RUNNER_REDIRECTS) {
      throw new Error('Local-runner request followed too many redirects.')
    }
    const location = res.headers.get('location')
    if (!location) return res
    current = new URL(location, current).toString()
  }
}
