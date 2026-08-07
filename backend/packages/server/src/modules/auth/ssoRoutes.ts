import {
  SSO_ERROR_FRAGMENT_KEY,
  ssoCallbackContract,
  ssoLoginContract,
} from '@cat-factory/contracts'
import type { SsoErrorReason } from '@cat-factory/contracts'
import { buildHonoRoute } from '@toad-contracts/hono'
import type { Hono } from 'hono'
import type { Context } from 'hono'
import { deleteCookie, getCookie } from 'hono/cookie'
import { UnavailableError, oidcIdentitySubject, runBestEffort } from '@cat-factory/kernel'
import type { Logger } from '@cat-factory/kernel'
import {
  OidcClient,
  OidcFlowError,
  createPkcePair,
  ssoNotConfigured,
} from '../../auth/oidc/OidcClient.js'
import { OidcProviderDirectory } from '../../auth/oidc/discovery.js'
import {
  judgeSsoAdmission,
  needsUserinfo,
  readSsoIdentity,
  userinfoMatchesSubject,
} from '../../auth/oidc/claims.js'
import type { SsoIdentity } from '../../auth/oidc/claims.js'
import { HmacSigner, TOKEN_AUDIENCE } from '../../auth/signing.js'
import type { AuthConfig, SsoConfig } from '../../config/types.js'
import type { AppEnv } from '../../http/env.js'
import { requestLogger } from '../../http/requestLogging.js'
import {
  OAUTH_STATE_TTL_MS,
  acceptInvite,
  authConfig,
  emailMatchesInvite,
  mintSession,
  peekInvite,
  pickPostLoginRedirect,
  resolveRedirect,
  sessionGenerationFor,
  sessionUser,
  setRoundTripCookie,
  withToken,
} from './loginFlow.js'

// ---------------------------------------------------------------------------
// Enterprise SSO sign-in: `GET /auth/sso/login` → the IdP → `GET /auth/sso/callback`.
//
// ONE pair of routes serves every OpenID Connect provider, because the provider's own discovery
// document supplies the endpoints (see `auth/oidc/discovery.ts`). What this module owns is the
// round-trip's STATE and its refusals.
//
// The state differs from the GitHub/Google flow in one way that matters. Those carry a signed
// state token in the URL and bind it to a cookie holding just its nonce. SSO cannot: PKCE's
// `code_verifier` and OIDC's `nonce` are SECRETS that must not travel in a URL — a verifier
// visible beside the code it protects protects nothing. So the whole round-trip rides in the
// httpOnly cookie (signed, audience-pinned with the SAME `HmacSigner` the OAuth flow uses, so
// CSRF protection stays one implementation) and only an opaque nonce goes in the `state`
// parameter. That also means the post-login redirect target cannot be tampered with in the URL,
// which is strictly stronger than the OAuth leg.
//
// Refusals REDIRECT rather than rendering an error envelope: a browser mid-redirect that lands on
// raw JSON has no way back, and the reason is a closed vocabulary the SPA maps to translated copy
// (`SSO_ERROR_REASONS`). The redirect target is only ever a TRUSTED one — the cookie's own
// recorded target, or `pickPostLoginRedirect` with no requested value — never a query parameter,
// because the failure path must not become the open redirect the success path is guarded against.
// ---------------------------------------------------------------------------

/** The httpOnly cookie carrying one SSO round-trip. Distinct from the OAuth flow's. */
const SSO_STATE_COOKIE = 'cf_sso_state'

/**
 * One SSO round-trip, signed and held in an httpOnly cookie.
 *
 * `verifier` and `idNonce` are why the cookie exists rather than a URL state: they are the two
 * secrets that make an intercepted authorization code and a replayed ID token useless.
 */
interface SsoRoundTrip {
  aud: typeof TOKEN_AUDIENCE.ssoState
  /** Echoed as the OAuth `state` parameter; the CSRF binding between URL and cookie. */
  nonce: string
  /** PKCE `code_verifier`. */
  verifier: string
  /** The `nonce` claim the returned ID token must carry. */
  idNonce: string
  /** Where to land the browser afterwards — resolved (and allow-listed) at login time. */
  redirect: string
  invite?: string
  exp: number
}

function ssoConfig<E extends AppEnv>(c: Context<E>): SsoConfig {
  const cfg = authConfig(c).sso
  if (!cfg) ssoNotConfigured()
  return cfg
}

/**
 * The redirect_uri, which must match what is registered with the IdP EXACTLY. Explicit
 * configuration wins, because a deployment behind a proxy or a custom domain sees a request
 * origin that is not its public one, and a derived value would then be rejected by the provider
 * with the least helpful error it has (`invalid_grant`).
 */
function ssoCallbackUrl<E extends AppEnv>(c: Context<E>, cfg: SsoConfig): string {
  if (cfg.redirectUrl) return cfg.redirectUrl
  return `${new URL(c.req.url).origin}/auth/sso/callback`
}

/**
 * Build the OIDC client for this request. A fresh instance per request is deliberate: the
 * expensive part (the discovery document) lives in the shared app cache, so the client itself
 * holds no state worth reusing and none worth leaking between requests.
 */
function ssoClient<E extends AppEnv>(c: Context<E>, cfg: SsoConfig): OidcClient {
  const logger = requestLogger(c)
  return new OidcClient({
    config: cfg,
    directory: new OidcProviderDirectory({
      cache: c.get('container').caches?.ssoDiscovery,
      logger,
    }),
    logger,
  })
}

/** Land the browser back on the SPA with a machine-readable reason instead of a session. */
function refuse(target: string, reason: SsoErrorReason): string {
  const url = new URL(target)
  url.hash = `${SSO_ERROR_FRAGMENT_KEY}=${reason}`
  return url.toString()
}

export function registerSsoRoutes(app: Hono<AppEnv>): void {
  buildHonoRoute(app, ssoLoginContract, async (c) => {
    const cfg = authConfig(c)
    const sso = ssoConfig(c)
    const { verifier, challenge } = await createPkcePair()
    const trip: SsoRoundTrip = {
      aud: TOKEN_AUDIENCE.ssoState,
      nonce: crypto.randomUUID(),
      verifier,
      idNonce: crypto.randomUUID(),
      redirect: resolveRedirect(c, cfg),
      ...(c.req.query('invite') ? { invite: c.req.query('invite') } : {}),
      exp: Date.now() + OAUTH_STATE_TTL_MS,
    }
    setRoundTripCookie(c, SSO_STATE_COOKIE, await new HmacSigner(cfg.sessionSecret).sign(trip))
    // Resolving the provider can fail (an unreachable IdP, a malformed discovery document). It
    // throws an `UnavailableError` naming which, and the shared error handler renders it: this is
    // the one leg where an envelope is right, because nothing has redirected yet and the operator
    // is the audience.
    const url = await ssoClient(c, sso).authorizeUrl({
      redirectUri: ssoCallbackUrl(c, sso),
      state: trip.nonce,
      nonce: trip.idNonce,
      codeChallenge: challenge,
    })
    return c.redirect(url)
  })

  buildHonoRoute(app, ssoCallbackContract, async (c) => {
    const cfg = authConfig(c)
    const sso = ssoConfig(c)
    const trip = await consumeRoundTrip(c, cfg)
    // With no verified round-trip there is no recorded landing URL, so fall back to the
    // deployment's own configured target (or its origin) — never the request's `redirect` query,
    // which is exactly the untrusted value the success path allow-lists.
    const fallback = pickPostLoginRedirect(undefined, new URL(c.req.url).origin, cfg)
    if (!trip) return c.redirect(refuse(fallback, 'state_invalid'))

    // The IdP's own refusal (`access_denied` when a user cancels or the app is not assigned to
    // them) is reported as itself rather than as a token failure: there is nothing on this side
    // to fix, and saying "invalid token" would send an operator hunting one.
    if (c.req.query('error')) {
      requestLogger(c).info('sso.provider_denied', { error: c.req.query('error') })
      return c.redirect(refuse(trip.redirect, 'provider_denied'))
    }
    const code = c.req.query('code')
    if (!code) return c.redirect(refuse(trip.redirect, 'state_invalid'))

    const client = ssoClient(c, sso)
    let resolved: { identity: SsoIdentity | null; issuer: string }
    try {
      resolved = await resolveIdentity(client, sso, {
        code,
        redirectUri: ssoCallbackUrl(c, sso),
        trip,
        logger: requestLogger(c),
      })
    } catch (err) {
      // An IdP that stopped answering mid-round-trip is an OUTAGE, not a bad token and not this
      // deployment's credentials, so it gets its own reason. It also has to REDIRECT: on the login
      // leg an envelope is right (nothing has redirected yet, the operator is the audience), but
      // here the browser is mid-flow and raw JSON leaves it with no way back.
      if (err instanceof UnavailableError) {
        requestLogger(c).warn('sso.provider_unreachable', { detail: err.message })
        return c.redirect(refuse(trip.redirect, 'provider_unreachable'))
      }
      if (!(err instanceof OidcFlowError)) throw err
      // The message names the operator-actionable cause (a wrong secret, a redirect_uri the IdP
      // does not hold, a clock skew); the user gets the reason code. Logged at WARN because a
      // deployment whose SSO cannot complete is broken, not busy.
      requestLogger(c).warn(`sso.${err.reason}`, { detail: err.message })
      return c.redirect(refuse(trip.redirect, err.reason))
    }
    const { identity, issuer } = resolved
    if (!identity) return c.redirect(refuse(trip.redirect, 'subject_missing'))

    const admission = judgeSsoAdmission(identity, sso)
    if (!admission.allowed) {
      // A refusal is the OFFBOARDING signal, not merely a failed login: the directory that used to
      // admit this person no longer does. Re-reading the groups on sign-in already stops them
      // getting a NEW session; this ends the ones they are already holding, which is the half a
      // stateless token cannot do on its own and the reason SSO's offboarding promise needed a
      // revocation slice at all.
      const revoked = await revokeRefusedSessions(c, issuer, identity.sub)
      requestLogger(c).info('sso.refused', {
        reason: admission.reason,
        login: identity.login,
        // Recorded because "we refused them and they still hold a live bearer" and "we refused
        // them and cut their sessions" are different security outcomes, and only the second is
        // the offboarding this feature claims. `false` is the ordinary case for someone who never
        // had an account here.
        sessionsRevoked: revoked,
      })
      return c.redirect(refuse(trip.redirect, admission.reason))
    }

    const token = await establishSession(c, cfg, identity, issuer, trip)
    return c.redirect(withToken(trip.redirect, token))
  })
}

/**
 * End every live session of a user the directory has just refused, reporting whether there was
 * one to end.
 *
 * Keyed on the SAME `iss#sub` subject the sign-in path uses, never the email: a departed employee
 * whose address was reassigned must not have the new holder's sessions revoked, and the email is
 * display data precisely because it moves.
 *
 * BEST-EFFORT, and this is the one place in the flow where that is right. The refusal itself has
 * already succeeded — the person is not getting a session — so a store failure here must not turn
 * a correct denial into a 500 that reads to an operator as a broken SSO configuration. It is
 * WARNED rather than swallowed, because a revocation that silently did not happen is exactly the
 * gap this closes, and `runBestEffort` is what keeps the report attached to the cause.
 */
async function revokeRefusedSessions<E extends AppEnv>(
  c: Context<E>,
  issuer: string,
  sub: string,
): Promise<boolean> {
  const container = c.get('container')
  let revoked = false
  await runBestEffort(
    requestLogger(c),
    'sso.revoke_refused_sessions',
    async () => {
      const user = await container.userService.findByIdentity(
        'oidc',
        oidcIdentitySubject(issuer, sub),
      )
      // No user means nobody ever signed in with this identity, so there is nothing to revoke —
      // the ordinary case for an outsider hitting the login, not a failure.
      if (!user) return
      await container.userService.revokeSessions(user.id)
      revoked = true
    },
    { issuer },
  )
  return revoked
}

/**
 * Exchange the code, verify the ID token, and merge in userinfo when — and only when — a claim
 * admission depends on is missing from the token. `identity` is null when the verified token
 * carries no `sub`, the one shape that leaves nothing to key an identity on.
 *
 * Returns the DISCOVERED issuer alongside it, so the caller keying the user's identity on it does
 * not resolve the provider a second time: that second read is what put an IdP outage AFTER the
 * admission decision, where nothing was left to report it with.
 */
async function resolveIdentity(
  client: OidcClient,
  sso: SsoConfig,
  params: { code: string; redirectUri: string; trip: SsoRoundTrip; logger: Logger },
): Promise<{ identity: SsoIdentity | null; issuer: string }> {
  const tokens = await client.exchangeCode({
    code: params.code,
    redirectUri: params.redirectUri,
    codeVerifier: params.trip.verifier,
  })
  const claims = (await client.verifyIdToken(tokens.idToken, {
    nonce: params.trip.idNonce,
  })) as Record<string, unknown>
  let merged = claims
  if (tokens.accessToken && needsUserinfo(claims, sso)) {
    const extra = await client.fetchUserInfo(tokens.accessToken)
    // The ID token's claims WIN over userinfo's: the token is signed and the userinfo response is
    // only bearer-authenticated, so on a disagreement the verified half is authoritative. `sub`
    // in particular must never be taken from userinfo.
    //
    // And the response is only merged AT ALL when it describes the same subject the token did
    // (OIDC Core 5.3.2): spreading `claims` last protects `sub` itself, but `email` and `groups`
    // ride the same response and both decide admission, so another subject's response would
    // satisfy a group gate with somebody else's membership. Dropped LOUDLY, because the visible
    // consequence otherwise is a `group_required` refusal blamed on the operator's group names.
    if (extra && userinfoMatchesSubject(extra, claims)) merged = { ...extra, ...claims }
    else if (extra) {
      params.logger.warn('sso.userinfo.subject_mismatch', {
        // Separates a non-conformant provider OMITTING the required claim (an operator fixes which
        // claims it releases) from a response genuinely describing somebody else (alarming, and a
        // different conversation). Neither subject value is logged.
        userinfoHasSub: typeof extra.sub === 'string' && extra.sub.trim() !== '',
      })
    }
  }
  const { metadata } = await client.provider()
  return { identity: readSsoIdentity(merged, sso), issuer: metadata.issuer }
}

/**
 * Resolve the canonical user for a verified SSO identity and mint its session.
 *
 * The subject is `<discovered issuer>#<sub>`, never the email: emails are reassigned inside orgs
 * and some directories let a user change their own, so keying on one would hand a departed
 * employee's account to whoever inherits their address.
 */
async function establishSession<E extends AppEnv>(
  c: Context<E>,
  cfg: AuthConfig,
  identity: SsoIdentity,
  issuer: string,
  trip: SsoRoundTrip,
): Promise<string> {
  const container = c.get('container')
  const user = await container.userService.findOrCreateByIdentity(
    'oidc',
    oidcIdentitySubject(issuer, identity.sub),
    {
      name: identity.name,
      email: identity.email,
      emailVerified: identity.emailVerified,
      avatarUrl: identity.avatarUrl,
      metadata: { issuer, login: identity.login },
    },
  )
  await container.accountService.ensurePersonalAccount({
    id: user.id,
    login: identity.login,
    name: user.name,
  })
  // An SSO user reached here through the IdP's own app assignment, so an invite is not what
  // ADMITTED them — it only decides which org they join. Honoured when present (a person invited
  // by email who then signs in with SSO), and bound to the invited address exactly as every other
  // provider binds it, so a leaked link cannot pull an arbitrary directory user into an org.
  if (trip.invite) {
    const invited = await peekInvite(c, trip.invite)
    if (invited && emailMatchesInvite(identity.email, invited.email)) {
      await acceptInvite(c, trip.invite, user.id, user.email)
    }
  }
  const { token } = await mintSession(
    cfg,
    sessionUser(user, identity.login),
    await sessionGenerationFor(c, user.id),
  )
  logSignIn(requestLogger(c), user.id, identity, issuer)
  return token
}

/**
 * One line per successful SSO sign-in, at INFO.
 *
 * Deliberate: an org adopting SSO is doing it to answer "who has access", and a login that leaves
 * no trace answers nothing. Group memberships are logged as a COUNT rather than a list — the list
 * is directory data of unbounded size, and its presence or absence is what diagnoses a
 * `group_required` refusal.
 */
function logSignIn(logger: Logger, userId: string, identity: SsoIdentity, issuer: string): void {
  logger.info('sso.signed_in', {
    userId,
    issuer,
    login: identity.login,
    emailVerified: identity.emailVerified,
    groupCount: identity.groups.length,
  })
}

/**
 * Verify + single-use the round-trip cookie, and check it against the `state` parameter the IdP
 * echoed back. Returns null on any mismatch, which the caller reports as `state_invalid`.
 *
 * The cookie is deleted whatever the outcome, so one round-trip can be completed exactly once —
 * which is also what makes a captured callback URL useless on a second visit.
 */
async function consumeRoundTrip<E extends AppEnv>(
  c: Context<E>,
  cfg: AuthConfig,
): Promise<SsoRoundTrip | null> {
  const raw = getCookie(c, SSO_STATE_COOKIE)
  deleteCookie(c, SSO_STATE_COOKIE, { path: '/auth' })
  const trip = await new HmacSigner(cfg.sessionSecret).verify<SsoRoundTrip>(raw, {
    aud: TOKEN_AUDIENCE.ssoState,
  })
  if (!isCompleteRoundTrip(trip)) return null
  const state = c.req.query('state')
  if (!state || state !== trip.nonce) return null
  return trip
}

/**
 * Whether a verified cookie payload actually carries the round-trip this leg needs.
 *
 * `HmacSigner.verify` proves THIS deployment signed the value and pins its audience; neither
 * proves its SHAPE, and the generic parameter is a cast rather than a check. Without this, a
 * payload missing the two secrets would flow on as `undefined`: a PKCE `code_verifier` of
 * `"undefined"` in the token form and a nonce compared against `undefined`, both of which a
 * conformant provider refuses — which is exactly why the check belongs here instead of resting on
 * one being conformant.
 */
function isCompleteRoundTrip(trip: SsoRoundTrip | null): trip is SsoRoundTrip {
  const present = (value: unknown): boolean => typeof value === 'string' && value !== ''
  return (
    trip !== null &&
    present(trip.nonce) &&
    present(trip.verifier) &&
    present(trip.idNonce) &&
    present(trip.redirect)
  )
}
