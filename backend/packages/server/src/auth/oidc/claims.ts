import type { SsoErrorReason } from '@cat-factory/contracts'
import type { SsoConfig } from '../../config/types.js'

// ---------------------------------------------------------------------------
// Reading an identity out of OIDC claims, and deciding whether it may sign in.
//
// Pure functions over plain claim bags, kept out of the controller so the two judgements that
// actually matter — what counts as the identity, and who is admitted — are unit-testable
// without a browser round-trip or a fake IdP.
//
// The recurring trap these encode: enterprise providers disagree about the SHAPE of a claim far
// more than about its name. A groups claim arrives as an array of strings from Okta and
// Keycloak, as a single string from a provider releasing one value, and occasionally as an array
// of objects with a `value` field. A reader that assumes one shape does not fail loudly — it
// reads zero groups, and a `requiredGroups` gate that reads zero groups refuses everybody, which
// looks exactly like "the operator got the group names wrong".
// ---------------------------------------------------------------------------

/** The identity an SSO round-trip resolved, normalised across providers. */
export interface SsoIdentity {
  /** The provider's `sub` — the stable identity, never the email. */
  sub: string
  email: string | null
  /**
   * Whether the email may be trusted to LINK this login onto an existing same-email user.
   *
   * `email_verified` is absent from a great many enterprise ID tokens even though the address is
   * authoritative — it comes from the corporate directory, which is the whole trust model an
   * operator adopted this IdP for. So absence is treated as verified and only an EXPLICIT
   * `email_verified: false` is honoured as unverified. The alternative (requiring the claim)
   * silently creates a second user for anyone who also signed in with GitHub, and — because
   * `users.email` is unique and an unverified email is dropped — leaves the SSO account with no
   * email at all, which breaks invitations and every roster display. The residual risk is
   * bounded by the IdP: a directory that lets a user self-assert another person's corporate
   * address has already lost, with or without this claim.
   */
  emailVerified: boolean
  name: string | null
  avatarUrl: string | null
  /** A display handle: `preferred_username`, else the email, else the `sub`. */
  login: string
  /** Group memberships read from the configured claim, lowercased. Empty when none released. */
  groups: string[]
}

/** Whether a sign-in is admitted, and if not, which rule refused it. */
export type SsoAdmission = { allowed: true } | { allowed: false; reason: SsoErrorReason }

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/**
 * Read a group-membership claim, tolerating every shape providers ship it in: an array of
 * strings, a single string, a space-separated string (some SAML-to-OIDC bridges), or an array of
 * `{ value }` / `{ name }` objects. Anything unrecognised contributes nothing rather than
 * throwing: one odd entry must not discard the rest of a user's groups.
 */
export function readGroupClaim(claims: Record<string, unknown>, claimName: string): string[] {
  if (!claimName) return []
  const raw = claims[claimName]
  const values = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw]
  const out: string[] = []
  for (const entry of values) {
    if (typeof entry === 'string') {
      // A single string may itself be a space-separated list; splitting is safe because a
      // group name containing a space is not addressable by a CSV allowlist anyway.
      for (const part of entry.split(/\s+/)) {
        if (part) out.push(part.toLowerCase())
      }
      continue
    }
    if (entry && typeof entry === 'object') {
      const nested = str(
        (entry as Record<string, unknown>).value ?? (entry as Record<string, unknown>).name,
      )
      if (nested) out.push(nested.toLowerCase())
    }
  }
  return out
}

/**
 * Build the identity from the merged claim bag (ID token, with any userinfo claims overlaid).
 *
 * Returns null when there is no `sub`: without it there is no stable key, and inventing one from
 * the email would key a user's account on a value orgs reassign.
 */
export function readSsoIdentity(
  claims: Record<string, unknown>,
  cfg: Pick<SsoConfig, 'groupsClaim'>,
): SsoIdentity | null {
  const sub = str(claims.sub)
  if (!sub) return null
  const email = str(claims.email)?.toLowerCase() ?? null
  const preferred = str(claims.preferred_username)
  return {
    sub,
    email,
    emailVerified: claims.email_verified !== false && email !== null,
    name: str(claims.name) ?? joinName(claims),
    avatarUrl: str(claims.picture),
    login: preferred ?? email ?? sub,
    groups: readGroupClaim(claims, cfg.groupsClaim),
  }
}

/** `given_name` + `family_name`, for providers that release no composed `name`. */
function joinName(claims: Record<string, unknown>): string | null {
  const parts = [str(claims.given_name), str(claims.family_name)].filter(
    (part): part is string => part !== null,
  )
  return parts.length > 0 ? parts.join(' ') : null
}

/**
 * Whether this identity may sign in.
 *
 * The default is ADMIT, and that is the feature rather than an oversight: with SSO configured,
 * the identity provider's own app assignment IS the allowlist, which is precisely the capability
 * an org adopts SSO to get (onboarding and — the one that matters — offboarding happen in the
 * directory, not in a list here). Contrast the GitHub login path, which fails closed with both
 * its lists empty: there, nothing else expresses who is allowed.
 *
 * The two optional narrowings are for orgs whose IdP serves more than the population that should
 * reach this deployment, and they are checked in the order whose refusal is most actionable:
 *
 *  1. `requiredGroups` — the user is in none of the named directory groups.
 *  2. `allowedEmailDomains` — their email's domain is not listed. A configured domain gate with
 *     NO email released is refused (`email_required`) rather than admitted: admitting would void
 *     a rule the operator wrote, and the fix (release the `email` claim) belongs to them.
 */
export function judgeSsoAdmission(
  identity: SsoIdentity,
  cfg: Pick<SsoConfig, 'allowedEmailDomains' | 'requiredGroups'>,
): SsoAdmission {
  if (cfg.requiredGroups.length > 0) {
    const member = identity.groups.some((group) => cfg.requiredGroups.includes(group))
    if (!member) return { allowed: false, reason: 'group_required' }
  }
  if (cfg.allowedEmailDomains.length > 0) {
    if (!identity.email || !identity.emailVerified) {
      return { allowed: false, reason: 'email_required' }
    }
    const at = identity.email.lastIndexOf('@')
    const domain = at < 0 ? '' : identity.email.slice(at + 1)
    if (!cfg.allowedEmailDomains.includes(domain)) {
      return { allowed: false, reason: 'domain_not_allowed' }
    }
  }
  return { allowed: true }
}

/**
 * Whether the ID token's claims are enough to decide admission and populate a profile, or
 * whether the userinfo endpoint has to be called too.
 *
 * Asked so the extra round-trip happens only when it can change the outcome. Most enterprise
 * providers put `email` in the ID token but release `groups` only from userinfo (Entra ID
 * notably), and one unconditional userinfo call per login is a latency cost paid by every
 * deployment to serve the ones that need it.
 */
export function needsUserinfo(
  claims: Record<string, unknown>,
  cfg: Pick<SsoConfig, 'groupsClaim' | 'requiredGroups' | 'allowedEmailDomains'>,
): boolean {
  if (!str(claims.email)) return true
  if (cfg.requiredGroups.length > 0 && readGroupClaim(claims, cfg.groupsClaim).length === 0) {
    return true
  }
  return false
}
