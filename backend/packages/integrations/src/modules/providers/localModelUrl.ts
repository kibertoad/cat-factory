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

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

/** Whether a hostname (no port) is a loopback or RFC1918/ULA private host we forward to. */
function isLoopbackOrPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  // mDNS `.local` names resolve only on the LAN — acceptable for a same-network runner.
  if (h.endsWith('.local')) return true
  const v4 = IPV4.exec(h)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    if ([a, b, Number(v4[3]), Number(v4[4])].some((n) => n > 255)) return false
    if (a === 127) return true // loopback 127.0.0.0/8
    if (a === 10) return true // private 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true // private 172.16.0.0/12
    if (a === 192 && b === 168) return true // private 192.168.0.0/16
    return false // public, 0.0.0.0, and link-local 169.254.0.0/16 (metadata) → denied
  }
  // IPv6 literals (URL.hostname strips the brackets).
  if (h === '::1') return true // loopback
  if (h.startsWith('fc') || h.startsWith('fd')) return true // ULA fc00::/7
  // fe80::/10 (link-local), :: (unspecified), and global addresses → denied.
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
  if (!isLoopbackOrPrivateHost(url.hostname)) {
    return (
      'A local runner must live on your own machine or LAN (localhost, *.local, or a ' +
      'private 10./172.16–31./192.168. address). Public or remote hosts are not allowed.'
    )
  }
  return null
}
