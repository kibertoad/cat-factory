// Shared, dependency-free IPv4-literal decoding + internal/metadata host
// classification for the SSRF guards. Every provider that stores and later fetches an
// org-supplied URL (Atlassian sites, ephemeral-environment management APIs, the
// Kubernetes apiserver) validates the host against the local network first. The
// decoding + classification primitives live here so each guard composes ONE vetted
// implementation rather than copying it. Host-literal defence-in-depth only — it does
// not stop DNS rebinding — but it blocks the obvious internal targets including the
// obfuscated IPv4 encodings (bare integer, hex/octal octets, IPv4-mapped IPv6) that
// trivially bypass a naive dotted-decimal match.

/** Whether a decoded IPv4 address is loopback / link-local (metadata) / RFC1918. */
export function isPrivateV4(parts: [number, number, number, number]): boolean {
  const [a, b] = parts
  if (a === 127 || a === 0 || a === 10) return true
  if (a === 169 && b === 254) return true
  if (a === 192 && b === 168) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  return false
}

/** Parse a plain dotted-decimal IPv4 literal (each octet 0-255), or null. */
export function decimalV4(host: string): [number, number, number, number] | null {
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
export function mappedV4(host: string): [number, number, number, number] | null {
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
  // ::ffff:hhhh:hhhh (the form `new URL` normalizes `::ffff:1.2.3.4` to).
  const hex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (hex) {
    const hi = parseInt(hex[1] ?? '0', 16)
    const lo = parseInt(hex[2] ?? '0', 16)
    return [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff]
  }
  return null
}

/**
 * Decode any IPv4 literal encoding to its octets: dotted-decimal, IPv4-mapped IPv6
 * (dotted or hex-group form), or a bare 32-bit integer (`2130706433` === 127.0.0.1).
 * Returns null when `host` is not an IPv4 literal in any of those forms. Use this when
 * a policy needs to inspect the address (e.g. block only metadata); a guard that
 * rejects ALL numeric forms outright should use {@link isBlockedPrivateHost}.
 */
export function decodeIpv4(host: string): [number, number, number, number] | null {
  const dotted = decimalV4(host)
  if (dotted) return dotted
  const mapped = mappedV4(host)
  if (mapped) return mapped
  if (/^\d+$/.test(host)) {
    const n = Number(host)
    if (n > 0xffffffff) return null
    return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]
  }
  return null
}

/**
 * Whether a host resolves to a known cloud-metadata / link-local target — the endpoint
 * an SSRF would aim at for instance credentials. Covers the metadata hostnames plus the
 * whole link-local range (169.254.0.0/16, incl. 169.254.169.254 IMDS) and the per-vendor
 * metadata IPs, across every obfuscated IPv4 encoding. Used by guards (like the
 * Kubernetes apiserver URL) that ALLOW private hosts but must still block metadata.
 */
export function isCloudMetadataHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'metadata.google.internal') return true
  // AWS IPv6 IMDS.
  if (host === 'fd00:ec2::254') return true
  const v4 = decodeIpv4(host)
  if (v4) {
    const [a, b, c, d] = v4
    // The whole 169.254.0.0/16 link-local range (incl. 169.254.169.254 IMDS) — these
    // guards point at infrastructure that is never link-local, so block the range.
    if (a === 169 && b === 254) return true
    // Alibaba Cloud metadata.
    if (a === 100 && b === 100 && c === 100 && d === 200) return true
  }
  return false
}

/**
 * Reject hostnames that point at the local network rather than a public host: blocks
 * loopback, link-local (incl. cloud metadata), `.localhost`/`.internal`/`.local`, the
 * RFC1918 private ranges, and the obfuscated numeric encodings. The STRICT policy
 * behind the guards that require a public host (Atlassian sites, environment URLs).
 */
export function isBlockedPrivateHost(hostname: string): boolean {
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
