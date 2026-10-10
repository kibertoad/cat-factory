import type { AuthConfig, SsoConfig } from '@cat-factory/server'
import { resolveMachineTokenTtlMs, resolveSsoConfig } from '@cat-factory/server'
import type { Env } from '../env'
import { num } from './utils'

export type { AuthConfig }

/**
 * Minimum length for AUTH_SESSION_SECRET. The same secret keys the HMAC over
 * every session, OAuth-state, container-proxy and WS-ticket token; a short
 * secret is offline-brute-forceable, which would let an attacker forge a session.
 * A secret below this length is treated as misconfigured (auth disabled → the
 * gate fails closed with 503) rather than silently accepted.
 */
const MIN_SESSION_SECRET_LENGTH = 32

/** Deployment environments where the AUTH_DEV_OPEN escape hatch is refused. */
const PRODUCTION_ENVIRONMENTS = new Set(['production', 'prod', 'staging'])

/**
 * Resolve the per-provider enablement + credential fields from the env — the decision-heavy
 * prelude of {@link loadAuthConfig}, extracted so that builder stays within the cyclomatic-
 * complexity budget. Behaviour is byte-identical (the checks moved verbatim).
 */
function resolveAuthEnablement(env: Env): {
  clientId: string
  clientSecret: string
  sessionSecret: string
  ttlHours: number | undefined
  devOpen: boolean
  testingNoAuth: boolean
  githubEnabled: boolean
  googleClientId: string
  googleClientSecret: string
  googleEnabled: boolean
  passwordEnabled: boolean
  sso: SsoConfig | undefined
} {
  // Enabled when the OAuth credentials and a sufficiently strong session secret
  // are all present, mirroring the GitHub-integration default-off convention.
  const clientId = env.GITHUB_OAUTH_CLIENT_ID?.trim() ?? ''
  const clientSecret = env.GITHUB_OAUTH_CLIENT_SECRET?.trim() ?? ''
  const sessionSecret = env.AUTH_SESSION_SECRET?.trim() ?? ''
  const ttlHours = num('AUTH_SESSION_TTL_HOURS', env.AUTH_SESSION_TTL_HOURS)
  // The local-dev escape hatch is honoured ONLY outside a production-like
  // deployment, so leaving AUTH_DEV_OPEN=true set on a deployed worker can no
  // longer silently re-open the API. Operators should set ENVIRONMENT=production.
  const environment = env.ENVIRONMENT?.trim().toLowerCase() ?? ''
  const nonProd = !PRODUCTION_ENVIRONMENTS.has(environment)
  // `TESTING_NO_AUTH` is a stronger `AUTH_DEV_OPEN`: besides leaving the API open it tells the
  // SPA to render the board anonymously (no login gate). Test-only; honoured only outside a
  // production-like ENVIRONMENT, and it implies devOpen.
  const testingNoAuth = env.TESTING_NO_AUTH?.trim() === 'true' && nonProd
  const devOpen = (env.AUTH_DEV_OPEN?.trim() === 'true' || testingNoAuth) && nonProd
  const strongSecret = sessionSecret.length >= MIN_SESSION_SECRET_LENGTH
  const githubEnabled = clientId !== '' && clientSecret !== '' && strongSecret
  // Google OAuth is offered only when its client id/secret are both present.
  const googleClientId = env.GOOGLE_OAUTH_CLIENT_ID?.trim() ?? ''
  const googleClientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET?.trim() ?? ''
  const googleEnabled = googleClientId !== '' && googleClientSecret !== '' && strongSecret
  const passwordEnabled = env.AUTH_PASSWORD_ENABLED?.trim() === 'true' && strongSecret
  // Enterprise SSO: parsed by the SHARED resolver both facades call, so its nine variables and
  // four boot refusals cannot drift between runtimes. It THROWS on a partial/unsafe combination
  // (including AUTH_DEV_OPEN alongside SSO) rather than resolving to disabled, and the Worker's
  // boot turns that into the misconfiguration screen naming the variable.
  const sso = resolveSsoConfig(env, { strongSessionSecret: strongSecret, devOpen })
  return {
    clientId,
    clientSecret,
    sessionSecret,
    ttlHours,
    devOpen,
    testingNoAuth,
    githubEnabled,
    googleClientId,
    googleClientSecret,
    googleEnabled,
    passwordEnabled,
    sso,
  }
}

export function loadAuthConfig(env: Env): AuthConfig {
  const {
    clientId,
    clientSecret,
    sessionSecret,
    ttlHours,
    devOpen,
    testingNoAuth,
    githubEnabled,
    googleClientId,
    googleClientSecret,
    googleEnabled,
    passwordEnabled,
    sso,
  } = resolveAuthEnablement(env)
  return {
    // Enabled when ANY provider is configured (with a strong session secret).
    enabled: githubEnabled || googleEnabled || passwordEnabled || !!sso,
    devOpen,
    testingNoAuth,
    githubEnabled,
    clientId,
    clientSecret,
    sessionSecret,
    apiBase: env.GITHUB_API_BASE?.trim() || 'https://api.github.com',
    oauthBase: env.GITHUB_OAUTH_BASE?.trim() || 'https://github.com',
    sessionTtlMs: (ttlHours !== undefined && ttlHours > 0 ? ttlHours : 168) * 60 * 60 * 1000,
    machineTokenTtlMs: resolveMachineTokenTtlMs(env.AUTH_MACHINE_TOKEN_TTL_MS),
    successRedirectUrl: env.AUTH_SUCCESS_REDIRECT_URL?.trim() || '',
    callbackUrl: env.AUTH_CALLBACK_URL?.trim() || '',
    passwordEnabled,
    // Open (un-gated) signup is a local-mode convenience; the Worker stays invite/domain-gated.
    openSignup: env.AUTH_OPEN_SIGNUP?.trim() === 'true',
    // Always on here: a Worker only ever runs behind the Cloudflare edge, which injects
    // (and overwrites) cf-connecting-ip, so the header IS the socket truth on this facade.
    // One hop, and this facade reads the edge header directly rather than an x-forwarded-for
    // chain, so the count is only here to satisfy the shared shape.
    trustProxyHeaders: true,
    trustedProxyHops: 1,
    ...(googleEnabled
      ? {
          google: {
            clientId: googleClientId,
            clientSecret: googleClientSecret,
            redirectUrl: env.GOOGLE_OAUTH_REDIRECT_URL?.trim() || '',
          },
        }
      : {}),
    ...(sso ? { sso } : {}),
    allowedEmailDomains: (env.AUTH_ALLOWED_EMAIL_DOMAINS ?? '')
      .split(',')
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean),
    allowedLogins: (env.AUTH_ALLOWED_LOGINS ?? '')
      .split(',')
      .map((login) => login.trim().toLowerCase())
      .filter(Boolean),
    allowedOrgs: (env.AUTH_ALLOWED_ORGS ?? '')
      .split(',')
      .map((org) => org.trim().toLowerCase())
      .filter(Boolean),
    allowedRedirectOrigins: (env.AUTH_ALLOWED_REDIRECT_ORIGINS ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean)
      .map((origin) => {
        try {
          return new URL(origin).origin
        } catch {
          return origin
        }
      }),
  }
}
