import type { Env } from '../env'
import { num } from './utils'

export interface AuthConfig {
  enabled: boolean
  /**
   * Local-dev/test ONLY: permit running with auth unconfigured (open API). Never
   * set in production, so a misconfigured prod deployment fails closed rather
   * than serving protected data without a session. See `requireAuth`.
   */
  devOpen: boolean
  clientId: string
  clientSecret: string
  sessionSecret: string
  /** REST API base for reading the user (shared with the GitHub integration). */
  apiBase: string
  /** OAuth host (authorize/token endpoints). */
  oauthBase: string
  /** Session token lifetime in milliseconds. */
  sessionTtlMs: number
  /** Fixed post-login landing URL; '' means honour the request-provided one. */
  successRedirectUrl: string
  /** Explicit OAuth redirect_uri; '' means derive it from the request origin. */
  callbackUrl: string
  /**
   * Lowercased GitHub logins permitted to sign in. Combined with `allowedOrgs`
   * as an OR allowlist; when BOTH are empty, nobody may sign in (fail closed).
   */
  allowedLogins: string[]
  /**
   * Lowercased GitHub org logins whose members may sign in. A user is admitted
   * when they belong to any of these orgs (resolved from GitHub at login).
   * Combined with `allowedLogins` as an OR allowlist; when BOTH are empty,
   * nobody may sign in (fail closed). See AuthController's callback.
   */
  allowedOrgs: string[]
  /**
   * Extra origins the post-login `redirect` query may target, beyond the request
   * origin (which is always allowed). Empty means same-origin only.
   */
  allowedRedirectOrigins: string[]
}

/**
 * Minimum length for AUTH_SESSION_SECRET. The same secret keys the HMAC over
 * every session, OAuth-state, container-proxy and WS-ticket token; a short
 * secret is offline-brute-forceable, which would let an attacker forge a session.
 * A secret below this length is treated as misconfigured (auth disabled → the
 * gate fails closed with 503) rather than silently accepted.
 */
export const MIN_SESSION_SECRET_LENGTH = 32

/** Deployment environments where the AUTH_DEV_OPEN escape hatch is refused. */
const PRODUCTION_ENVIRONMENTS = new Set(['production', 'prod', 'staging'])

export function loadAuthConfig(env: Env): AuthConfig {
  // Enabled when the OAuth credentials and a sufficiently strong session secret
  // are all present, mirroring the GitHub-integration default-off convention.
  const clientId = env.GITHUB_OAUTH_CLIENT_ID?.trim() ?? ''
  const clientSecret = env.GITHUB_OAUTH_CLIENT_SECRET?.trim() ?? ''
  const sessionSecret = env.AUTH_SESSION_SECRET?.trim() ?? ''
  const ttlHours = num(env.AUTH_SESSION_TTL_HOURS)
  // The local-dev escape hatch is honoured ONLY outside a production-like
  // deployment, so leaving AUTH_DEV_OPEN=true set on a deployed worker can no
  // longer silently re-open the API. Operators should set ENVIRONMENT=production.
  const environment = env.ENVIRONMENT?.trim().toLowerCase() ?? ''
  const devOpen = env.AUTH_DEV_OPEN?.trim() === 'true' && !PRODUCTION_ENVIRONMENTS.has(environment)
  return {
    enabled:
      clientId !== '' && clientSecret !== '' && sessionSecret.length >= MIN_SESSION_SECRET_LENGTH,
    devOpen,
    clientId,
    clientSecret,
    sessionSecret,
    apiBase: env.GITHUB_API_BASE?.trim() || 'https://api.github.com',
    oauthBase: env.GITHUB_OAUTH_BASE?.trim() || 'https://github.com',
    sessionTtlMs: (ttlHours !== undefined && ttlHours > 0 ? ttlHours : 168) * 60 * 60 * 1000,
    successRedirectUrl: env.AUTH_SUCCESS_REDIRECT_URL?.trim() || '',
    callbackUrl: env.AUTH_CALLBACK_URL?.trim() || '',
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
