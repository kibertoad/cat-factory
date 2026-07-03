// ---------------------------------------------------------------------------
// SSRF guard for local-runner base URLs. A runner lives on the user's OWN machine
// (or LAN), so we forward requests to a user-supplied base URL server-side (both the
// "Test connection" probe and the run-time LLM proxy). The usual "block private IPs"
// mitigation is backwards here — loopback/LAN is exactly the intended target — so
// instead we ALLOW only loopback + RFC1918/ULA private hosts and reject everything
// else. This keeps the feature working on a single-tenant Node/local deployment (the
// server shares the LAN with the runner) while denying a tenant on the shared
// Cloudflare facade the ability to probe arbitrary public hosts or the link-local
// cloud-metadata endpoint (169.254.169.254 / fe80::). Public/remote runners are not
// supported by design.
// ---------------------------------------------------------------------------

import { decodeIpv4, isCloudMetadataHost, isPrivateV4 } from '@cat-factory/kernel'

/** Whether a hostname (no port) is a loopback or RFC1918/ULA private host we forward to. */
function isLoopbackOrPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (h === '') return false
  // Cloud-metadata / link-local endpoints (169.254.0.0/16, metadata.google.internal,
  // fd00:ec2::254, …) are the primary SSRF target. Deny them FIRST — some (the whole
  // 169.254/16 range) would otherwise look "private" — across every obfuscated encoding.
  if (isCloudMetadataHost(h)) return false

  if (h === 'localhost' || h.endsWith('.localhost')) return true
  // mDNS `.local` names resolve only on the LAN — acceptable for a same-network runner.
  if (h.endsWith('.local')) return true

  // IPv6 literals (URL.hostname keeps them bracketless here → they contain a colon).
  // Gating the ULA prefix test behind this colon check is what stops a registrable DNS
  // name like `fc2.com` / `fd-x.evil.com` from masquerading as a private fc00::/7 host.
  if (h.includes(':')) {
    if (h === '::1') return true // loopback
    if (h.startsWith('fc') || h.startsWith('fd')) return true // ULA fc00::/7
    // IPv4-mapped IPv6 (e.g. `::ffff:10.0.0.1`) → classify by the embedded IPv4.
    const mapped = decodeIpv4(h)
    if (mapped) return mapped[0] !== 0 && isPrivateV4(mapped)
    // fe80::/10 (link-local), :: (unspecified), and global addresses → denied.
    return false
  }

  // IPv4 in any form the WHATWG URL parser may leave us (it canonicalises hex/octal/
  // integer hosts to dotted-decimal before we see them; `decodeIpv4` covers the rest
  // defensively). `isPrivateV4` accepts 127/8, 10/8, 172.16/12, 192.168/16 — plus 0.*
  // and 169.254.* which we exclude (0.0.0.0/8 unspecified; metadata handled above).
  const v4 = decodeIpv4(h)
  if (v4) return v4[0] !== 0 && isPrivateV4(v4)

  // Public hostname / anything unrecognised → denied.
  return false
}

/**
 * Validate a local-runner base URL. Returns a human-readable error string when the URL
 * is malformed or points at a non-local host, or `null` when it's acceptable. Used by
 * the service at the write boundary and by the "Test connection" probe.
 */
export function localRunnerUrlError(rawUrl: string): string | null {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return 'Enter a valid URL, e.g. http://localhost:11434/v1.'
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'A runner URL must use http or https.'
  }
  // Embedded credentials (`user:pass@host`) have no legitimate use for a local runner
  // and are a classic way to smuggle an unexpected authority past a naive check.
  if (url.username || url.password) {
    return 'A runner URL must not contain credentials.'
  }
  if (!isLoopbackOrPrivateHost(url.hostname)) {
    return (
      'A local runner must live on your own machine or LAN (localhost, *.local, or a ' +
      'private 10./172.16–31./192.168. address). Public or remote hosts are not allowed.'
    )
  }
  return null
}

/** Max redirect hops the revalidating fetch will follow before giving up. */
const MAX_LOCAL_RUNNER_REDIRECTS = 5

/**
 * Fetch a local-runner URL, re-validating the SSRF allow-list on EVERY redirect hop.
 *
 * The allow-list permits loopback/LAN hosts, but a permitted private runner can still
 * `302` to a denied host — most dangerously the cloud-metadata endpoint
 * (169.254.169.254) — and the platform `fetch` would follow it silently. So we drive
 * redirects by hand (`redirect: 'manual'`) and run {@link localRunnerUrlError} against
 * each `Location` before following it, mirroring the environment provider's `safeFetch`.
 * Both server-side callers (the "Test connection" probe and the run-time LLM proxy
 * forward) use this instead of a bare `fetch`. Throws when a hop fails validation or the
 * redirect chain is too long.
 */
export async function fetchLocalRunner(
  rawUrl: string,
  init: RequestInit,
  doFetch: typeof fetch = fetch,
): Promise<Response> {
  let current = rawUrl
  for (let hop = 0; ; hop++) {
    const err = localRunnerUrlError(current)
    if (err) throw new Error(`Blocked local-runner request: ${err}`)
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
