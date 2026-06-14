import type { Env } from '../env'

export interface GitHubConfig {
  enabled: boolean
  appId: string
  appSlug: string
  apiBase: string
  /** Browser redirect target after a successful connect (falls back to '/'). */
  setupRedirectUrl: string
}

export function loadGitHubConfig(env: Env): GitHubConfig {
  // Enabled when the App id and both secrets are present; the integration is
  // entirely opt-in, matching the AGENTS_ENABLED default-off convention.
  const appId = env.GITHUB_APP_ID?.trim() ?? ''
  const enabled = appId !== '' && !!env.GITHUB_APP_PRIVATE_KEY && !!env.GITHUB_WEBHOOK_SECRET
  return {
    enabled,
    appId,
    appSlug: env.GITHUB_APP_SLUG?.trim() ?? '',
    apiBase: env.GITHUB_API_BASE?.trim() || 'https://api.github.com',
    setupRedirectUrl: env.GITHUB_SETUP_REDIRECT_URL?.trim() || '/',
  }
}
