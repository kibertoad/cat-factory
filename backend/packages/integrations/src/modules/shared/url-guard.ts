import {
  isBlockedPrivateHost,
  STRICT_URL_SAFETY_POLICY,
  ValidationError,
} from '@cat-factory/kernel'
import type { UrlSafetyPolicy } from '@cat-factory/kernel'

// The SSRF scheme/host guard shared by EVERY caller that stores or fetches an org-supplied URL:
// the Atlassian sites (Confluence pages, Jira issues), the ephemeral-environment platform, the
// self-hosted runner-pool scheduler, the outbound notification webhook. It is the write-boundary
// half of the pair `safeFetch` completes: this decides whether a URL may be fetched at all,
// `safeFetch` re-runs it on every redirect hop so a permitted first host can't bounce the request
// to an internal target.
//
// ONE implementation, deliberately: an SSRF bypass found here (a new obfuscated IP encoding, a
// scheme confusion) must be fixable in one place. Each caller supplies only its own error wording
// and its own `UrlSafetyPolicy`, resolved from its OWN config slice, so widening one integration's
// allow-list never widens another's.
//
// It lives HERE rather than in kernel, and the Atlassian base-URL guard moved here to join it,
// because the parse below is the WHATWG `URL` and kernel's TS lib deliberately has no web globals:
// a leaf that could see `URL` could see `fetch` and `document` too. Kernel keeps the part with no
// runtime surface, the host classifier (`ip-host.logic`). Before the move the Atlassian guard
// carried its own copy of the parse, which is exactly the split this module exists to remove.

/** Per-call wording + policy for {@link assertSafePublicUrl}. */
export interface PublicUrlGuardOptions {
  /** What owns the URL, capitalised for the message ('Environment', 'Notification webhook'). */
  subject: string
  /** Which URL of that subject ('base URL', 'endpoint', 'OAuth token URL'). */
  label?: string
  /**
   * The widened policy, when the deployment configured one. Defaults to
   * {@link STRICT_URL_SAFETY_POLICY}: `https` only, no private/internal hosts.
   */
  policy?: UrlSafetyPolicy
}

/**
 * Validate a URL before it is stored or fetched. The default policy requires `https` and rejects
 * internal/private hosts (loopback, RFC1918, the link-local range including the 169.254.169.254
 * cloud-metadata endpoint); a trusted operator-installed integration can pass a widened policy to
 * permit specific schemes/hosts. Embedded credentials are forbidden regardless of policy.
 *
 * **Parsed with the WHATWG `URL`, which is the whole security property here.** A guard that picks
 * the authority out with its own regex answers a question `fetch` never asked: the two disagree on
 * a backslash (`https://10.0.0.5\.vendor.example` is host `10.0.0.5` to `fetch` and a long
 * innocent-looking hostname to a regex), on userinfo, on a trailing dot, and on how an IPv6
 * literal is spelled. Every one of those disagreements is a bypass, and the class of them closes
 * only by validating the SAME parse that will be dialled. `URL` is a web standard present on
 * workerd and Node alike, so this stays runtime-neutral.
 */
export function assertSafePublicUrl(url: string, options: PublicUrlGuardOptions): void {
  const { subject, label = 'URL', policy = STRICT_URL_SAFETY_POLICY } = options
  const invalid = () => new ValidationError(`${subject} ${label} is not a valid URL: '${url}'`)

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw invalid()
  }

  const scheme = parsed.protocol.replace(/:$/, '').toLowerCase()
  if (!policy.schemes.includes(scheme)) {
    const allowed = policy.schemes.join('/') || '(none)'
    throw new ValidationError(`${subject} ${label} must use ${allowed}`)
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new ValidationError(`${subject} ${label} must not contain credentials`)
  }
  const host = parsed.hostname
  if (host === '') throw invalid()
  if (!hostExempt(host, policy) && isBlockedPrivateHost(host)) {
    throw new ValidationError(`${subject} ${label} must be a public host`)
  }
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
