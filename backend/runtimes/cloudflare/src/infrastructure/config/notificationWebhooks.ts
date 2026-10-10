import type { NotificationWebhookConfig } from '@cat-factory/server'
import type { Env } from '../env'
import { csv } from './utils'

export type { NotificationWebhookConfig }

/**
 * The outbound notification webhook has no enable flag — it assembles wherever the shared
 * ENCRYPTION_KEY is set (the signing secret must be sealable), and delivery is governed by whether
 * a workspace registered an endpoint. Only the SSRF guard is configurable: the strict
 * public-https default holds unless the operator names hosts to exempt (a receiver on an internal
 * / VPN host, or a developer's localhost listener).
 */
export function loadNotificationWebhookConfig(env: Env): NotificationWebhookConfig {
  return {
    allowUrlHosts: csv(env.NOTIFICATION_WEBHOOK_ALLOW_URL_HOSTS),
    allowHttpUrls: env.NOTIFICATION_WEBHOOK_ALLOW_HTTP_URLS === 'true',
  }
}
