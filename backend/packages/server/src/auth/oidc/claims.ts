import type { SsoErrorReason } from '@cat-factory/contracts'
import type { SsoConfig } from '../../config/types.js'
import { str } from './discovery.js'

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

/**
 * What a refusal is EVIDENCE OF, which is a different question from which rule fired.
 *
 * Every admission rule here fails closed, and that part is not in dispute. But a refusal is also
 * read as an OFFBOARDING signal — it is what ends the sessions the person is already holding —
 * and only one of these two kinds of refusal says anything at all about the person:
 *
 *  - `directory` — a claim the IdP DID release positively places them outside the policy: groups
 *    were released and none match, or a verified email was released and its domain is not
 *    allowed. The directory has spoken, and "they no longer belong here" is what it said.
 *  - `indeterminate` — the claim the rule needed was not released at all. This is equally
 *    consistent with a person removed from every group, a dropped `groups` scope, a renamed
 *    `groupsClaim`, a userinfo endpoint that stopped answering the claim, and an email the
 *    provider stopped marking verified. Nothing here can tell those apart, and the difference
 *    between them is the difference between one person leaving and the entire directory
 *    integration having regressed.
 *
 * The distinction exists because acting on the second as if it were the first turns a login
 * outage into a deployment-wide forced sign-out: on the release where a scope goes missing, every
 * returning employee is refused, and every refusal would cut every one of their live sessions,
 * including those of the admin who has to fix the configuration.
 */
type SsoRefusalEvidence = 'directory' | 'indeterminate'

/** Whether a sign-in is admitted, and if not, which rule refused it and on what evidence. */
export type SsoAdmission =
  | { allowed: true }
  | { allowed: false; reason: SsoErrorReason; evidence: SsoRefusalEvidence }

/**
 * Read a group-membership claim, tolerating every shape providers ship it in: an array of
 * strings, a single string, a space-separated string (some SAML-to-OIDC bridges), or an array of
 * `{ value }` / `{ name }` objects. Anything unrecognised contributes nothing rather than
 * throwing: one odd entry must not discard the rest of a user's groups.
 *
 * Whether a value is SPLIT on whitespace turns on whether something else already delimited it,
 * and getting that backwards is the silent lockout this whole file warns about. An ARRAY entry is
 * taken WHOLE: Okta, Entra ID and every AD-backed directory permit spaces in a group's name
 * ("Domain Admins" is the canonical one), `AUTH_SSO_REQUIRED_GROUPS` splits on COMMAS so such a
 * name is perfectly addressable, and shredding it into `domain` + `admins` matches nothing an
 * operator can write. Only a BARE STRING is genuinely ambiguous, and there the space-separated
 * spelling is the shape a whole-value read would get wrong.
 */
export function readGroupClaim(claims: Record<string, unknown>, claimName: string): string[] {
  if (!claimName) return []
  const raw = claims[claimName]
  if (typeof raw === 'string') {
    return raw
      .split(/\s+/)
      .filter(Boolean)
      .map((part) => part.toLowerCase())
  }
  const values = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw]
  const out: string[] = []
  for (const entry of values) {
    if (typeof entry === 'string') {
      const value = str(entry)
      if (value) out.push(value.toLowerCase())
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
 * Whether a claim states a NEGATIVE explicitly.
 *
 * `email_verified` is specified as a boolean and its ABSENCE is read as verified (the decision
 * documented on {@link SsoIdentity.emailVerified}), so the only thing this has to catch is a
 * provider that says "no". Some ship JSON booleans as strings, and `"false"` is the one spelling
 * where absence-means-verified would invert the provider's own answer rather than fill a gap.
 */
function statesFalse(value: unknown): boolean {
  return value === false || value === 'false'
}

/**
 * Whether a userinfo response describes the SAME subject the verified ID token did.
 *
 * OIDC Core 5.3.2 makes this a MUST, and it is not tidiness: overlaying the ID token's claims
 * LAST already stops `sub` itself from being taken from userinfo, but `email` and `groups` ride
 * the same response and BOTH decide admission. A response for another subject would hand this
 * user that subject's directory groups, which is the one way a `requiredGroups` gate can be
 * satisfied by somebody else's membership. A response with no `sub` at all fails this too: the
 * claim is REQUIRED there, and a merge that cannot be checked is not one to trust.
 */
export function userinfoMatchesSubject(
  userinfo: Record<string, unknown>,
  claims: Record<string, unknown>,
): boolean {
  const fromUserinfo = str(userinfo.sub)
  return fromUserinfo !== null && fromUserinfo === str(claims.sub)
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
    emailVerified: email !== null && !statesFalse(claims.email_verified),
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
 *
 * Each refusal also carries what it is EVIDENCE of ({@link SsoRefusalEvidence}), because the
 * caller does more with a refusal than deny the login: it ends the sessions the person already
 * holds. Deciding that here rather than at the call site is the point — the reason code alone
 * cannot answer it (`group_required` is the directory speaking when groups WERE released and
 * merely a missing claim when they were not), and a caller re-deriving it from the reason string
 * would have to know which claims this function looked at.
 */
export function judgeSsoAdmission(
  identity: SsoIdentity,
  cfg: Pick<SsoConfig, 'allowedEmailDomains' | 'requiredGroups'>,
): SsoAdmission {
  if (cfg.requiredGroups.length > 0) {
    const member = identity.groups.some((group) => cfg.requiredGroups.includes(group))
    if (!member) {
      // Released-but-not-matching is the directory excluding this person. NOTHING released is a
      // claim we did not receive, and "removed from every group" is indistinguishable from "the
      // groups scope stopped being granted" — the shape a whole deployment regresses in at once.
      const evidence = identity.groups.length > 0 ? 'directory' : 'indeterminate'
      return { allowed: false, reason: 'group_required', evidence }
    }
  }
  if (cfg.allowedEmailDomains.length > 0) {
    if (!identity.email || !identity.emailVerified) {
      // Always indeterminate: an absent address and one the provider stopped marking verified
      // both say nothing about whether this person still belongs to the organisation.
      return { allowed: false, reason: 'email_required', evidence: 'indeterminate' }
    }
    const at = identity.email.lastIndexOf('@')
    const domain = at < 0 ? '' : identity.email.slice(at + 1)
    if (!cfg.allowedEmailDomains.includes(domain)) {
      // A verified address WAS released and its domain is not one the operator admits.
      return { allowed: false, reason: 'domain_not_allowed', evidence: 'directory' }
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
