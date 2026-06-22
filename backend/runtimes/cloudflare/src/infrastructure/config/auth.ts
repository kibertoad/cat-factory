import type { AuthConfig } from '@cat-factory/server'
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
  const strongSecret = sessionSecret.length >= MIN_SESSION_SECRET_LENGTH
  const githubEnabled = clientId !== '' && clientSecret !== '' && strongSecret
  // Google OAuth is offered only when its client id/secret are both present.
  const googleClientId = env.GOOGLE_OAUTH_CLIENT_ID?.trim() ?? ''
  const googleClientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET?.trim() ?? ''
  const googleEnabled = googleClientId !== '' && googleClientSecret !== '' && strongSecret
  const passwordEnabled = env.AUTH_PASSWORD_ENABLED?.trim() === 'true' && strongSecret
  return {
    // Enabled when ANY provider is configured (with a strong session secret).
    enabled: githubEnabled || googleEnabled || passwordEnabled,
    devOpen,
    githubEnabled,
    clientId,
    clientSecret,
    sessionSecret,
    apiBase: env.GITHUB_API_BASE?.trim() || 'https://api.github.com',
    oauthBase: env.GITHUB_OAUTH_BASE?.trim() || 'https://github.com',
    sessionTtlMs: (ttlHours !== undefined && ttlHours > 0 ? ttlHours : 168) * 60 * 60 * 1000,
    successRedirectUrl: env.AUTH_SUCCESS_REDIRECT_URL?.trim() || '',
    callbackUrl: env.AUTH_CALLBACK_URL?.trim() || '',
    passwordEnabled,
    ...(googleEnabled
      ? {
          google: {
            clientId: googleClientId,
            clientSecret: googleClientSecret,
            redirectUrl: env.GOOGLE_OAUTH_REDIRECT_URL?.trim() || '',
          },
        }
      : {}),
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
