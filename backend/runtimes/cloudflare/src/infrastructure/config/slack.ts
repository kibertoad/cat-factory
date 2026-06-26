import type { SlackConfig } from '@cat-factory/server'
import type { Env } from '../env'

export type { SlackConfig }

export function loadSlackConfig(env: Env): SlackConfig {
  // Opt-in via the enable flag; the per-account bot token is sealed with the shared
  // ENCRYPTION_KEY (under a slack-scoped HKDF info). The Slack app OAuth credentials moved
  // out of env into per-account settings (sealed), resolved dynamically at connect time —
  // see AccountSettingsService / `/accounts/:id/settings`.
  const encryptionKey = env.ENCRYPTION_KEY?.trim()
  return {
    enabled: env.SLACK_ENABLED === 'true' && !!encryptionKey,
    encryptionKey,
  }
}
