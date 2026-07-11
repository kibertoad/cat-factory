import {
  type GitHubConfig,
  type PrivilegedAppConfig,
  requireGitHubAppPrivateKey,
} from '@cat-factory/server'
import type { Env } from '../env'

export type { GitHubConfig, PrivilegedAppConfig }

export function loadGitHubConfig(env: Env): GitHubConfig {
  // Enabled when the App id and both secrets are present; the integration is
  // entirely opt-in (a default-off convention shared by the optional integrations).
  const appId = env.GITHUB_APP_ID?.trim() ?? ''
  const enabled = appId !== '' && !!env.GITHUB_APP_PRIVATE_KEY && !!env.GITHUB_WEBHOOK_SECRET
  // Validate the App private key's SHAPE at boot (present + PKCS#8 PEM + decodable body) whenever
  // the App is configured, so a malformed key fails on the misconfigured screen with the openssl
  // conversion remedy rather than opaquely at the first installation-token mint (error-message
  // coverage A3). Mirrors the Node loader; the shared validator keeps the message identical.
  if (enabled) requireGitHubAppPrivateKey(env.GITHUB_APP_PRIVATE_KEY)
  return {
    enabled,
    appId,
    appSlug: env.GITHUB_APP_SLUG?.trim() ?? '',
    apiBase: env.GITHUB_API_BASE?.trim() || 'https://api.github.com',
    setupRedirectUrl: env.GITHUB_SETUP_REDIRECT_URL?.trim() || '/',
    webhookSecret: env.GITHUB_WEBHOOK_SECRET ?? '',
    privilegedApp: loadPrivilegedApp(env),
  }
}

// The privileged tier only activates when both its id and key are present;
// either alone is treated as unconfigured so a half-set env never silently
// authenticates as a misconfigured App.
function loadPrivilegedApp(env: Env): PrivilegedAppConfig | undefined {
  const appId = env.GITHUB_PRIVILEGED_APP_ID?.trim() ?? ''
  if (appId === '' || !env.GITHUB_PRIVILEGED_APP_PRIVATE_KEY) return undefined
  // Same boot-time shape validation as the default App key (error-message coverage A3).
  requireGitHubAppPrivateKey(
    env.GITHUB_PRIVILEGED_APP_PRIVATE_KEY,
    'GITHUB_PRIVILEGED_APP_PRIVATE_KEY',
  )
  return { appId }
}
