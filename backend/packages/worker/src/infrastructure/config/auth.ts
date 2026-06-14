import type { Env } from '../env'
import { num } from './utils'

export interface AuthConfig {
  enabled: boolean
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
  /** Lowercased GitHub logins permitted to sign in; empty means allow any. */
  allowedLogins: string[]
  /**
   * Extra origins the post-login `redirect` query may target, beyond the request
   * origin (which is always allowed). Empty means same-origin only.
   */
  allowedRedirectOrigins: string[]
}

export function loadAuthConfig(env: Env): AuthConfig {
  // Enabled when the OAuth credentials and the session secret are all present,
  // mirroring the GitHub-integration / AGENTS_ENABLED default-off convention.
  const clientId = env.GITHUB_OAUTH_CLIENT_ID?.trim() ?? ''
  const clientSecret = env.GITHUB_OAUTH_CLIENT_SECRET?.trim() ?? ''
  const sessionSecret = env.AUTH_SESSION_SECRET?.trim() ?? ''
  const ttlHours = num(env.AUTH_SESSION_TTL_HOURS)
  return {
    enabled: clientId !== '' && clientSecret !== '' && sessionSecret !== '',
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
