import type { SsoConfig } from './types.js'
import { DOCS, ENV_VARS_ANCHORS } from './docs.js'
import { configProblem } from './problems.js'

// ---------------------------------------------------------------------------
// Enterprise SSO config, resolved from the environment ONCE for every facade.
//
// Both runtime facades build their own `AuthConfig` (the Worker from its `Env` bindings, Node
// from `process.env`), and the GitHub/Google blocks are duplicated between them. That
// duplication is affordable for a two-field credential pair and is NOT affordable here: SSO
// carries nine variables, three boot refusals, and a scope-normalisation rule, and a facade
// that drifted on any of them would either serve a different admission policy or brick a boot
// the other one accepts. So the whole thing lives here and each facade calls it — the same
// shape as `resolveMachineTokenTtlMs` / `resolveTrustedProxyHops`, one size up.
//
// The refusals THROW rather than disabling SSO quietly. An operator wiring SSO is doing it to
// satisfy a security review; a half-configured provider that silently leaves the deployment on
// consumer logins is the exact failure they would not notice, and the Worker and Node facades
// both already turn a `ConfigValidationError` into the misconfiguration screen that names the
// variable and its remedy.
// ---------------------------------------------------------------------------

/** The environment slice this resolver reads. Both `Env` (Worker) and `process.env` satisfy it. */
export interface SsoEnv {
  AUTH_SSO_ISSUER_URL?: string
  AUTH_SSO_CLIENT_ID?: string
  AUTH_SSO_CLIENT_SECRET?: string
  AUTH_SSO_LABEL?: string
  AUTH_SSO_SCOPES?: string
  AUTH_SSO_REDIRECT_URL?: string
  AUTH_SSO_ALLOWED_EMAIL_DOMAINS?: string
  AUTH_SSO_GROUPS_CLAIM?: string
  AUTH_SSO_REQUIRED_GROUPS?: string
}

/** Scopes every request carries whether or not the operator listed them. */
const REQUIRED_SCOPE = 'openid'
const DEFAULT_SCOPES = 'openid profile email'
const DEFAULT_LABEL = 'Single sign-on'
/** The claim most IdPs release group memberships under (Okta, Keycloak, Entra ID). */
const DEFAULT_GROUPS_CLAIM = 'groups'

const SSO_DOC_URL = DOCS.envVars(ENV_VARS_ANCHORS.authentication)

function csv(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

/**
 * Whether an issuer URL is safe to send a browser (and a client secret) to: `https`, or `http`
 * on a loopback host so a Keycloak/Dex container on a developer's own machine is usable.
 *
 * Refused rather than warned about, because the failure mode of a plain-`http` issuer on a real
 * network is the authorization code and the ID token crossing it in clear.
 */
function isAcceptableIssuerUrl(url: URL): boolean {
  if (url.protocol === 'https:') return true
  if (url.protocol !== 'http:') return false
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host)
}

/**
 * Normalise the configured issuer URL: trim, drop a trailing slash, and accept the two
 * spellings operators paste interchangeably — the issuer itself
 * (`https://acme.okta.com/oauth2/default`) or the full discovery URL
 * (`…/.well-known/openid-configuration`). Both resolve to the same document, and refusing one
 * of them would be a config puzzle with no diagnostic value.
 */
function normalizeIssuerUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '')
  return trimmed.replace(/\/\.well-known\/openid-configuration$/i, '')
}

/**
 * Requested scopes, with `openid` guaranteed present. An operator who overrides
 * `AUTH_SSO_SCOPES` to name the claims their IdP needs (`openid email groups`) must not be able
 * to accidentally drop the one scope that makes the response an OIDC response at all — without
 * it there is no ID token to verify and the flow degrades to bare OAuth.
 */
function resolveScopes(raw: string | undefined): string {
  const requested = (raw ?? '').trim()
  if (!requested) return DEFAULT_SCOPES
  const scopes = requested.split(/\s+/).filter(Boolean)
  return scopes.includes(REQUIRED_SCOPE) ? scopes.join(' ') : [REQUIRED_SCOPE, ...scopes].join(' ')
}

/**
 * Resolve the deployment's enterprise-SSO config, or `undefined` when none of its variables are
 * set (the overwhelmingly common case: SSO is opt-in).
 *
 * Throws a `ConfigValidationError` — which both facades render as the misconfiguration
 * screen — for the four states that must never boot into a running deployment:
 *
 *  1. **Partially configured.** Any one of issuer / client id / client secret present without
 *     the others. Disabling quietly would leave an operator who believes SSO is live on the
 *     consumer logins they adopted SSO to replace.
 *  2. **An unusable issuer URL.** Not parseable, or plain `http` on a non-loopback host, which
 *     would carry the authorization code and ID token in clear.
 *  3. **A session secret too weak to sign the session SSO mints.** SSO establishes identity; the
 *     session it produces is the same HMAC bearer every other login mints, so a brute-forceable
 *     secret makes the IdP's guarantees irrelevant. (Same refusal the GitHub pair already gets,
 *     with no `AUTH_DEV_OPEN` escape — see 4.)
 *  4. **`AUTH_DEV_OPEN` alongside SSO.** Dev-open serves every protected route anonymously. A
 *     deployment that configured SSO to pass a security review must not have a variable
 *     combination that opens the API, and an operator cannot be relied on to notice they set
 *     both — so the pair is refused rather than resolved to one of them winning.
 */
export function resolveSsoConfig(
  env: SsoEnv,
  opts: { strongSessionSecret: boolean; devOpen: boolean },
): SsoConfig | undefined {
  const rawIssuer = env.AUTH_SSO_ISSUER_URL?.trim() ?? ''
  const clientId = env.AUTH_SSO_CLIENT_ID?.trim() ?? ''
  const clientSecret = env.AUTH_SSO_CLIENT_SECRET?.trim() ?? ''
  if (!rawIssuer && !clientId && !clientSecret) return undefined

  assertComplete({ rawIssuer, clientId, clientSecret })
  const issuerUrl = normalizeIssuerUrl(rawIssuer)
  assertUsableIssuer(issuerUrl)
  assertSessionIntegrity(opts)

  const groupsClaim = (env.AUTH_SSO_GROUPS_CLAIM ?? DEFAULT_GROUPS_CLAIM).trim()
  const requiredGroups = csv(env.AUTH_SSO_REQUIRED_GROUPS).map((group) => group.toLowerCase())
  assertGroupGateEvaluable({ groupsClaim, requiredGroups })

  return {
    issuerUrl,
    clientId,
    clientSecret,
    label: env.AUTH_SSO_LABEL?.trim() || DEFAULT_LABEL,
    scopes: resolveScopes(env.AUTH_SSO_SCOPES),
    redirectUrl: env.AUTH_SSO_REDIRECT_URL?.trim() || '',
    allowedEmailDomains: csv(env.AUTH_SSO_ALLOWED_EMAIL_DOMAINS).map((d) => d.toLowerCase()),
    groupsClaim,
    requiredGroups,
  }
}

function assertComplete(parts: {
  rawIssuer: string
  clientId: string
  clientSecret: string
}): void {
  const missing = [
    parts.rawIssuer ? null : 'AUTH_SSO_ISSUER_URL',
    parts.clientId ? null : 'AUTH_SSO_CLIENT_ID',
    parts.clientSecret ? null : 'AUTH_SSO_CLIENT_SECRET',
  ].filter((name): name is string => name !== null)
  if (missing.length === 0) return
  throw configProblem({
    key: missing[0]!,
    summary:
      'Enterprise SSO is partially configured: some of its variables are set, so a sign-in button was intended, but the rest are missing.',
    remedy:
      `Set ${missing.join(', ')} as well (all three of AUTH_SSO_ISSUER_URL, AUTH_SSO_CLIENT_ID ` +
      `and AUTH_SSO_CLIENT_SECRET are required), or unset the ones that ARE set to run without SSO. ` +
      `The issuer URL is your provider's own — e.g. https://acme.okta.com/oauth2/default, ` +
      `https://login.microsoftonline.com/<tenant>/v2.0, or your Keycloak realm URL.`,
    docsUrl: SSO_DOC_URL,
  })
}

function assertUsableIssuer(issuerUrl: string): void {
  let parsed: URL
  try {
    parsed = new URL(issuerUrl)
  } catch {
    throw configProblem({
      key: 'AUTH_SSO_ISSUER_URL',
      summary: 'The enterprise SSO issuer URL is not a URL, so no discovery document can be read.',
      remedy:
        "Set AUTH_SSO_ISSUER_URL to your provider's absolute issuer URL, e.g. `https://acme.okta.com/oauth2/default`. The `/.well-known/openid-configuration` suffix is optional — it is appended when absent.",
      docsUrl: SSO_DOC_URL,
    })
  }
  if (isAcceptableIssuerUrl(parsed)) return
  throw configProblem({
    key: 'AUTH_SSO_ISSUER_URL',
    summary:
      'The enterprise SSO issuer URL is not https, so the authorization code and the ID token would cross the network in clear.',
    remedy:
      'Use the https issuer URL your provider publishes. Plain http is accepted only for a loopback host (localhost / 127.0.0.0/8 / ::1), for a provider running on your own machine.',
    docsUrl: SSO_DOC_URL,
  })
}

function assertSessionIntegrity(opts: { strongSessionSecret: boolean; devOpen: boolean }): void {
  if (opts.devOpen) {
    throw configProblem({
      key: 'AUTH_DEV_OPEN',
      summary:
        'AUTH_DEV_OPEN (or TESTING_NO_AUTH) serves every protected route anonymously, which cancels the access control enterprise SSO was configured to enforce.',
      remedy:
        'Unset AUTH_DEV_OPEN and TESTING_NO_AUTH on any deployment that configures AUTH_SSO_ISSUER_URL. To run the API open for local development or a test suite, unset the AUTH_SSO_* variables instead — the two are refused together rather than one silently winning.',
      docsUrl: SSO_DOC_URL,
    })
  }
  if (opts.strongSessionSecret) return
  throw configProblem({
    key: 'AUTH_SESSION_SECRET',
    summary:
      'Enterprise SSO is configured but the session secret is missing or too short. SSO establishes WHO signs in; the session it mints is the same HMAC bearer token every other login mints, so a brute-forceable secret lets a session be forged regardless of what the identity provider enforced.',
    remedy:
      'Set AUTH_SESSION_SECRET to a random string of at least 32 characters (`openssl rand -hex 32`), stable across restarts.',
    docsUrl: SSO_DOC_URL,
  })
}

function assertGroupGateEvaluable(parts: { groupsClaim: string; requiredGroups: string[] }): void {
  if (parts.requiredGroups.length === 0 || parts.groupsClaim !== '') return
  throw configProblem({
    key: 'AUTH_SSO_GROUPS_CLAIM',
    summary:
      "AUTH_SSO_REQUIRED_GROUPS names the directory groups allowed to sign in, but AUTH_SSO_GROUPS_CLAIM is empty, so there is no claim to read a user's groups from and the gate could never be evaluated.",
    remedy:
      "Set AUTH_SSO_GROUPS_CLAIM to the claim your provider releases group memberships under (`groups` for Okta / Keycloak / Entra ID, `entitlement` or `isMemberOf` for a Shibboleth OP), or clear AUTH_SSO_REQUIRED_GROUPS to let the provider's own app assignment be the whole allowlist.",
    docsUrl: SSO_DOC_URL,
  })
}
