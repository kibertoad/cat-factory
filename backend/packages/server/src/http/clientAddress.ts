// ---------------------------------------------------------------------------
// Client-address resolution for the password throttle (SEC-4).
//
// The throttle's whole value rests on the address being one the CLIENT cannot choose:
// a spoofable value is unlimited fresh buckets (and, worse, the ability to pin a
// victim's bucket). Which header carries that address is a property of the FACADE's
// topology, not of the throttle, so the facade resolves it (`resolveClientAddress`) and
// only the normalisation below is shared:
//
//  - The Worker reads `cf-connecting-ip`. That header is authentic on that facade alone,
//    because the Cloudflare edge injects it and overwrites whatever the client sent.
//  - Node reads the socket peer by default, and `x-forwarded-for` only when
//    `AUTH_TRUST_PROXY=true`. It must NOT consult `cf-connecting-ip`: nginx / Caddy /
//    ALB / HAProxy rewrite `x-forwarded-for` and pass every other header through
//    untouched, so trusting a Cloudflare-specific header on a generic proxy leaves it
//    fully client-controlled.
// ---------------------------------------------------------------------------

/**
 * How many trusted proxies sit in front of this process (`AUTH_TRUST_PROXY_HOPS`).
 *
 * Defaults to 1, the single-reverse-proxy shape, and clamps to at least 1: a 0 would mean
 * "believe the leftmost entry", which is the client-controlled end of the chain and the very
 * spoof this setting exists to close. An unparseable value takes the default rather than
 * failing boot, matching how every other numeric knob here degrades.
 */
export function resolveTrustedProxyHops(raw: string | undefined): number {
  const parsed = Number.parseInt(raw?.trim() ?? '', 10)
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 1
}

/**
 * Pick the client hop out of an `x-forwarded-for` chain, given how many trusted proxies
 * sit in front of this process.
 *
 * The chain grows left to right as a request traverses proxies, so the RIGHTMOST entry was
 * appended by our nearest proxy and is the address that actually connected to it. That
 * makes rightmost correct under BOTH common configurations (nginx's appending
 * `proxy_add_x_forwarded_for` and an overwriting `proxy_set_header`), where leftmost is
 * correct only under the second and is otherwise whatever the client typed. With `n`
 * trusted proxies the client sits `n` from the end.
 *
 * Returns `null` when the header is absent, unparseable, or SHORTER than the configured
 * chain: a chain that does not look like the declared topology is not evidence about the
 * client, so the caller falls back to the socket peer rather than trusting a guess.
 */
export function forwardedClientAddress(
  header: string | undefined,
  trustedHops: number,
): string | null {
  if (!header) return null
  const hops = Math.max(1, Math.trunc(trustedHops))
  const entries = header
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
  const candidate = entries[entries.length - hops]
  if (!candidate) return null
  return normalizeClientAddress(candidate)
}

/**
 * Normalise one address into the form the throttle keys on, or `null` when it is not an
 * address at all.
 *
 * Two things happen here, both load-bearing:
 *
 *  - Anything not IP-shaped is REFUSED rather than passed through. A proxy that appends
 *    `ip:port` per connection, or an attacker sending free text, would otherwise mint a
 *    distinct bucket per request and land unbounded strings in the ledger's key column.
 *  - An IPv6 address is bucketed to its /64. A single residential or hosting allocation is
 *    routinely a /64 or larger, so keying on the full address gives an attacker 2^64
 *    buckets, which is the same hole as trusting a spoofable header.
 */
export function normalizeClientAddress(raw: string): string | null {
  let value = raw.trim().toLowerCase()
  if (!value) return null
  // `[2001:db8::1]:443` and `[2001:db8::1]` both carry a bracketed v6 literal.
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(value)
  if (bracketed?.[1]) value = bracketed[1]
  // A bare `1.2.3.4:443` from a port-appending proxy; a v6 literal has >1 colon so it is
  // never mistaken for one.
  else if ((value.match(/:/g) ?? []).length === 1) value = value.split(':')[0] ?? value
  // Drop an IPv6 zone index (`fe80::1%eth0`), which is host-local decoration.
  const zone = value.indexOf('%')
  if (zone >= 0) value = value.slice(0, zone)
  if (isIpv4(value)) return value
  const groups = expandIpv6(value)
  // The /64 is the routable unit; the interface half is the attacker's to vary freely.
  return groups ? `${groups.slice(0, 4).join(':')}::/64` : null
}

function isIpv4(value: string): boolean {
  const parts = value.split('.')
  return (
    parts.length === 4 &&
    parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255 && (p === '0' || !p.startsWith('0')))
  )
}

/** Expand an IPv6 literal to its eight 16-bit groups, or `null` if it is not one. */
function expandIpv6(value: string): string[] | null {
  if (!value.includes(':')) return null
  const halves = value.split('::')
  if (halves.length > 2) return null
  const parse = (part: string): string[] | null => {
    if (!part) return []
    const out: string[] = []
    for (const group of part.split(':')) {
      // A trailing dotted-quad (`::ffff:127.0.0.1`) occupies two groups.
      if (group.includes('.')) {
        if (!isIpv4(group)) return null
        const [a, b, c, d] = group.split('.').map(Number) as [number, number, number, number]
        out.push(hex((a << 8) | b), hex((c << 8) | d))
        continue
      }
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null
      out.push(group)
    }
    return out
  }
  const head = parse(halves[0] ?? '')
  const tail = halves.length === 2 ? parse(halves[1] ?? '') : null
  if (!head) return null
  if (halves.length === 1) return head.length === 8 ? head : null
  if (!tail) return null
  const fill = 8 - head.length - tail.length
  if (fill < 1) return null
  return [...head, ...Array.from({ length: fill }, () => '0'), ...tail]
}

function hex(n: number): string {
  return n.toString(16)
}
