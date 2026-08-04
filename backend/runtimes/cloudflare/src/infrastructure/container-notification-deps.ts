import type { Clock, NotificationChannel } from '@cat-factory/kernel'
import { CompositeNotificationChannel } from '@cat-factory/kernel'
import type { CoreDependencies } from '@cat-factory/orchestration'
import {
  NOTIFICATION_WEBHOOK_CIPHER_INFO,
  SLACK_CIPHER_INFO,
  SlackNotificationChannel,
  buildNotificationWebhookSupport,
} from '@cat-factory/integrations'
import { logger, resolveUrlSafetyPolicy } from '@cat-factory/server'
import type { AppConfig } from '@cat-factory/server'
import { WebCryptoSecretCipher } from './environments/WebCryptoSecretCipher'
import { D1BlockRepository } from './repositories/D1BlockRepository'
import { D1WorkspaceRepository } from './repositories/D1WorkspaceRepository'
import { D1NotificationWebhookRepository } from './repositories/D1NotificationWebhookRepository'
import {
  D1SlackConnectionRepository,
  D1SlackMemberMappingRepository,
  D1SlackSettingsRepository,
} from './repositories/D1SlackRepositories'
import type { Env } from './env'

// ---------------------------------------------------------------------------
// How the WORKER facade delivers a notification: the Slack transport, the outbound
// notification-webhook feature, and the composition of everything that is NOT the in-app push.
//
// Split out of `container.ts` as one cohesive collaborator (the file is a ratcheted size budget,
// and a budget is a split trigger rather than a number to raise). Delivery is a good seam to take
// out whole: every piece here shares one shape — an optional integration that wires only when its
// config and its sealing key are both present, and whose failures are LOGGED rather than raised,
// because a notification that does not arrive must never fail the run that raised it.
//
// Keep symmetric with the Node facade's own notification wiring: a channel wired on one runtime
// and forgotten on the other is a parity gap, not a follow-up.
// ---------------------------------------------------------------------------

/**
 * Construct the Slack repositories + bot-token cipher once, when the integration is
 * enabled — the single source of truth shared by both the delivery channel and the
 * management module so neither duplicates the wiring. Null when Slack is off.
 */
function buildSlackInfra(config: AppConfig, db: D1Database) {
  if (!config.slack.enabled || !config.slack.encryptionKey) return null
  return {
    connectionRepository: new D1SlackConnectionRepository({ db }),
    settingsRepository: new D1SlackSettingsRepository({ db }),
    memberMappingRepository: new D1SlackMemberMappingRepository({ db }),
    cipher: new WebCryptoSecretCipher({
      masterKeyBase64: config.slack.encryptionKey,
      info: SLACK_CIPHER_INFO,
    }),
  }
}

/**
 * Build the Slack notification channel when the integration is enabled — a
 * runtime-neutral transport (fetch + decrypt + D1 reads) composed alongside the
 * in-app channel. Null when Slack is off (then nothing Slack-related is wired).
 */
function buildSlackChannel(config: AppConfig, db: D1Database): SlackNotificationChannel | null {
  const infra = buildSlackInfra(config, db)
  if (!infra) return null
  return new SlackNotificationChannel({
    workspaceRepository: new D1WorkspaceRepository({ db }),
    slackConnectionRepository: infra.connectionRepository,
    slackSettingsRepository: infra.settingsRepository,
    slackMemberMappingRepository: infra.memberMappingRepository,
    blockRepository: new D1BlockRepository({ db }),
    secretCipher: infra.cipher,
    // Best-effort delivery still surfaces failures (revoked token, missing channel
    // invite) through the structured logger so a broken route is diagnosable.
    onError: (error, ctx) =>
      logger.warn('slack notification delivery failed', {
        err: error instanceof Error ? error.message : String(error),
        ...ctx,
      }),
  })
}

/**
 * Build the outbound notification-webhook feature (management service + delivery channel) when the
 * shared encryption key is present — the signing secret must be sealable. Both halves come from
 * one builder so they can't drift onto different repositories/ciphers. Null when no key is set;
 * then the management surface 503s and no deliveries are attempted.
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
  })
}

/**
 * This deployment's EXTERNAL notification channels — everything that is NOT the in-app push
 * (Slack, plus a workspace's outbound notification webhook). Two consumers:
 * {@link selectMergeLifecycleDeps} composes it into the engine's own fan-out, and the
 * ServerContainer attaches it as `machineNotificationDelivery`, the seam the mothership-mode
 * `POST /internal/notifications/deliver` endpoint delivers a laptop-raised notification through
 * (its credentials never leave this deployment). In-app is excluded there on purpose: a laptop's
 * in-app frame already arrives over the real-time upstream relay.
 *
 * The webhook belongs in this set for the same reason Slack does — its signing secret is sealed
 * with THIS deployment's key, so this is the only side that can decrypt and deliver it. Keeping it
 * out would leave a mothership-mode laptop failing every delivery on a decrypt it cannot perform
 * while the mothership never attempted one. Symmetric with the Node facade.
 *
 * Called once per consumer (so the seam gets its own instance), exactly like `buildAppRegistry`,
 * which the `githubTokenDelegation` seam also re-builds — the channel is a stateless adapter over
 * D1 reads plus a cipher, so a second instance costs nothing.
 */
export function buildExternalNotificationChannel(
  config: AppConfig,
  db: D1Database,
  webhookChannel?: NotificationChannel,
): NotificationChannel | null {
  const channels: NotificationChannel[] = []
  const slackChannel = buildSlackChannel(config, db)
  if (slackChannel) channels.push(slackChannel)
  if (webhookChannel) channels.push(webhookChannel)
  if (channels.length === 0) return null
  return channels.length === 1 ? channels[0]! : new CompositeNotificationChannel(channels)
}

/**
 * Wire the Slack management module (per-account connect + per-workspace routing +
 * member map). Wired only when the integration is enabled; the actual delivery is
 * the channel composed in by {@link selectMergeLifecycleDeps}. OAuth credentials
 * are optional — manual bot-token onboarding works without them.
 */
export function selectSlackDeps(config: AppConfig, db: D1Database): Partial<CoreDependencies> {
  const infra = buildSlackInfra(config, db)
  if (!infra) return {}
  return {
    slackConnectionRepository: infra.connectionRepository,
    slackSettingsRepository: infra.settingsRepository,
    slackMemberMappingRepository: infra.memberMappingRepository,
    slackSecretCipher: infra.cipher,
  }
}
