import type { Env } from '../env'

/**
 * The optional privileged App tier (ADR 0005): a second App registration that
 * carries `Administration: write` for creating repos. An org opts in by
 * installing this App (instead of / alongside the default), so the allow-list is
 * GitHub's own install state — no separate org list. Absent when
 * GITHUB_PRIVILEGED_APP_ID/key are unset — then every org runs on the default App.
 */
export interface PrivilegedAppConfig {
  appId: string
}

export interface GitHubConfig {
  enabled: boolean
  appId: string
  appSlug: string
  apiBase: string
  /** Browser redirect target after a successful connect (falls back to '/'). */
  setupRedirectUrl: string
  /** Present only when a privileged App is configured AND its key is supplied. */
  privilegedApp?: PrivilegedAppConfig
}

export function loadGitHubConfig(env: Env): GitHubConfig {
  // Enabled when the App id and both secrets are present; the integration is
  // entirely opt-in (a default-off convention shared by the optional integrations).
  const appId = env.GITHUB_APP_ID?.trim() ?? ''
  const enabled = appId !== '' && !!env.GITHUB_APP_PRIVATE_KEY && !!env.GITHUB_WEBHOOK_SECRET
  return {
    enabled,
    appId,
    appSlug: env.GITHUB_APP_SLUG?.trim() ?? '',
    apiBase: env.GITHUB_API_BASE?.trim() || 'https://api.github.com',
    setupRedirectUrl: env.GITHUB_SETUP_REDIRECT_URL?.trim() || '/',
    privilegedApp: loadPrivilegedApp(env),
  }
}

// The privileged tier only activates when both its id and key are present;
// either alone is treated as unconfigured so a half-set env never silently
// authenticates as a misconfigured App.
function loadPrivilegedApp(env: Env): PrivilegedAppConfig | undefined {
  const appId = env.GITHUB_PRIVILEGED_APP_ID?.trim() ?? ''
  if (appId === '' || !env.GITHUB_PRIVILEGED_APP_PRIVATE_KEY) return undefined
  return { appId }
}
