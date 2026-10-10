import {
  isBlockedPrivateHost,
  STRICT_URL_SAFETY_POLICY,
  ValidationError,
} from '@cat-factory/kernel'
import type { UrlSafetyPolicy } from '@cat-factory/kernel'

// The SSRF host/scheme guard shared by every integration that fetches an OPERATOR-SUPPLIED URL —
// the ephemeral-environment platform, the self-hosted runner-pool scheduler, the outbound
// notification webhook. It is the write-boundary half of the pair `safe-fetch.ts` completes: this
// decides whether a URL may be fetched at all, `safeFetch` re-runs it on every redirect hop so a
// permitted first host can't bounce the request to an internal target.
//
// ONE implementation, deliberately: an SSRF bypass found here (a new obfuscated IP encoding, a
// scheme confusion) must be fixable in one place. Each caller supplies only its own error wording
// and its own `UrlSafetyPolicy`, resolved from its OWN config slice — widening one integration's
// allow-list must never widen another's.

/** Per-call wording + policy for {@link assertSafePublicUrl}. */
export interface PublicUrlGuardOptions {
  /** What owns the URL, capitalised for the message ('Environment', 'Notification webhook'). */
  subject: string
  /** Which URL of that subject ('base URL', 'endpoint', 'OAuth token URL'). */
  label?: string
  /**
   * The widened policy, when the deployment configured one. Defaults to
   * {@link STRICT_URL_SAFETY_POLICY} — `https` only, no private/internal hosts.
   */
  policy?: UrlSafetyPolicy
}

/**
 * Validate a URL before it is stored or fetched. The default policy requires `https` and rejects
 * internal/private hosts (loopback, RFC1918, the link-local range including the 169.254.169.254
 * cloud-metadata endpoint); a trusted operator-installed integration can pass a widened policy to
 * permit specific schemes/hosts. Embedded credentials are forbidden regardless of policy.
 *
 * Parsed by hand (no `URL` global) so this stays in the platform-agnostic core and behaves
 * identically on workerd and Node.
 */
export function assertSafePublicUrl(url: string, options: PublicUrlGuardOptions): void {
  const { subject, label = 'URL', policy = STRICT_URL_SAFETY_POLICY } = options
  const invalid = () => new ValidationError(`${subject} ${label} is not a valid URL: '${url}'`)
  const match = url.match(URL_PREFIX)
  if (!match) throw invalid()

  if (!policy.schemes.includes(match[1]!.toLowerCase())) {
    const allowed = policy.schemes.join('/') || '(none)'
    throw new ValidationError(`${subject} ${label} must use ${allowed}`)
  }
  const authority = match[2]!
  if (authority.includes('@')) {
    throw new ValidationError(`${subject} ${label} must not contain credentials`)
  }
  const host = authorityHost(authority)
  if (host === null || host === '') throw invalid()
  if (!hostExempt(host, policy) && isBlockedPrivateHost(host)) {
    throw new ValidationError(`${subject} ${label} must be a public host`)
  }
}

/** Scheme and authority, up to the first `/`, `?` or `#`: what a client actually connects to. */
const URL_PREFIX = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)/

/**
 * The host inside an authority (port stripped, IPv6 brackets removed), or `null` for an
 * authority this parser cannot read.
 *
 * Split out so the guard above is not the only thing that can answer "what host does this URL
 * name": {@link publicUrlHost} lets a caller that GRADES a URL rather than admitting one read it
 * exactly as the admission does. Two hand-parsers over the same string would be two chances to
 * disagree about, say, a bracketed address.
 */
function authorityHost(authority: string): string | null {
  if (!authority.startsWith('[')) return authority.split(':')[0]!
  const end = authority.indexOf(']')
  return end === -1 ? null : authority.slice(1, end)
}

/**
 * The host a URL names, or `null` when it names none this parser can read.
 *
 * Parsed by hand for the same reason {@link assertSafePublicUrl} is: it stays in the
 * platform-agnostic core and behaves identically on workerd and Node. It also truncates at the
 * first `/` exactly as a client would, which matters to callers grading a RENDERED host: a
 * template that produced `host/with-a-slash.example` names `host`, and reading it any other way
 * would grade a name nothing will ever look up.
 */
export function publicUrlHost(url: string): string | null {
  const match = url.match(URL_PREFIX)
  if (!match) return null
  const host = authorityHost(match[2]!)
  return host === null || host === '' ? null : host
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
