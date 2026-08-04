import type { D1Database } from '@cloudflare/workers-types'
import {
  NOTIFICATION_WEBHOOK_CIPHER_INFO,
  buildNotificationWebhookSupport,
} from '@cat-factory/integrations'
import type { Clock } from '@cat-factory/kernel'
import { type AppConfig, logger, resolveUrlSafetyPolicy } from '@cat-factory/server'
import { WebCryptoSecretCipher } from './environments/WebCryptoSecretCipher'
import { D1NotificationWebhookRepository } from './repositories/D1NotificationWebhookRepository'
import type { Env } from './env'

// The Worker facade's wiring of the outbound-webhook feature, lifted out of the composition root
// (a file-size ratchet split; behaviour is identical). It is one cohesive decision — the endpoint
// guard, the sealing cipher and the three delivery families all follow from the deployment having
// an ENCRYPTION_KEY — and the root had no other reason to know about any of it.

/**
 * Build the outbound notification-webhook feature — the management service plus its three delivery
 * halves (notification cards, run lifecycle, platform-health alerts) — when the shared encryption
 * key is present, since the signing secret must be sealable. They all come from one builder so
 * they can't drift onto different repositories/ciphers. Null when no key is set; then the
 * management surface 503s and no deliveries are attempted.
 */
export function buildNotificationWebhookSupportForWorker(
  env: Env,
  config: AppConfig,
  db: D1Database,
  clock: Clock,
): ReturnType<typeof buildNotificationWebhookSupport> | null {
  const encryptionKey = env.ENCRYPTION_KEY?.trim()
  if (!encryptionKey) return null
  // The endpoint guard, resolved from the webhook's OWN config slice (undefined ⇒ the strict
  // public-https default). Handed to the builder, which gives it to both the write boundary and
  // the delivery path so they can't admit/reject different endpoints.
  const urlSafetyPolicy = resolveUrlSafetyPolicy(config.notificationWebhooks)
  return buildNotificationWebhookSupport({
    notificationWebhookRepository: new D1NotificationWebhookRepository({ db }),
    secretCipher: new WebCryptoSecretCipher({
      masterKeyBase64: encryptionKey,
      info: NOTIFICATION_WEBHOOK_CIPHER_INFO,
    }),
    clock,
    ...(urlSafetyPolicy ? { urlSafetyPolicy } : {}),
    // Best-effort delivery still surfaces failures (a dead endpoint, a rejected signature)
    // through the structured logger so a broken receiver is diagnosable.
    onError: (error, ctx) =>
      logger.warn('notification webhook delivery failed', {
        err: error instanceof Error ? error.message : String(error),
        ...ctx,
      }),
    onRunEventError: (error, ctx) =>
      logger.warn('run lifecycle webhook delivery failed', {
        err: error instanceof Error ? error.message : String(error),
        ...ctx,
      }),
    onPlatformAlertError: (error, ctx) =>
      logger.warn('platform health webhook delivery failed', {
        err: error instanceof Error ? error.message : String(error),
        ...ctx,
      }),
  })
}
