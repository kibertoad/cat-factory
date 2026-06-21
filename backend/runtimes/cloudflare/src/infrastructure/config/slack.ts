import type { SlackConfig } from '@cat-factory/server'
import type { Env } from '../env'

export type { SlackConfig }

export function loadSlackConfig(env: Env): SlackConfig {
  // Opt-in via the enable flag; the per-account bot token is sealed with the shared
  // ENCRYPTION_KEY (under a slack-scoped HKDF info). OAuth credentials are optional
  // (manual bot-token onboarding works without them); when all three are present the
  // "Add to Slack" flow is offered.
  const encryptionKey = env.ENCRYPTION_KEY?.trim()
  const clientId = env.SLACK_CLIENT_ID?.trim()
  const clientSecret = env.SLACK_CLIENT_SECRET?.trim()
  const redirectUrl = env.SLACK_REDIRECT_URL?.trim()
  const oauth =
    clientId && clientSecret && redirectUrl ? { clientId, clientSecret, redirectUrl } : undefined
  return {
    enabled: env.SLACK_ENABLED === 'true' && !!encryptionKey,
    encryptionKey,
    ...(oauth ? { oauth } : {}),
  }
}
