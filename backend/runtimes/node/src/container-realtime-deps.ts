import { type AgentKindRegistry } from '@cat-factory/agents'
import { ConsensusAgentExecutor, registerConsensusTraits } from '@cat-factory/consensus'
import {
  NOTIFICATION_WEBHOOK_CIPHER_INFO,
  SLACK_CIPHER_INFO,
  SlackNotificationChannel,
  buildNotificationWebhookSupport,
} from '@cat-factory/integrations'
import {
  type AgentExecutor,
  type Clock,
  CompositeNotificationChannel,
  type ModelProviderResolver,
  type NotificationChannel,
} from '@cat-factory/kernel'
import type { CoreDependencies } from '@cat-factory/orchestration'
import {
  type AppConfig,
  type CompositeAgentExecutor,
  FanOutEventPublisher,
  InAppNotificationChannel,
  WebCryptoSecretCipher,
  logger,
  resolveUrlSafetyPolicy,
} from '@cat-factory/server'
import type { DrizzleDb } from './db/client.js'
import { type LocalEventSink, NodeEventPublisher } from './realtime.js'
import type { createDrizzleRepositories } from './repositories/drizzle.js'
import { DrizzleNotificationWebhookRepository } from './repositories/drizzle/settings.js'
import {
  DrizzleSlackConnectionRepository,
  DrizzleSlackMemberMappingRepository,
  DrizzleSlackSettingsRepository,
} from './repositories/slack.js'

type NodeRepositories = ReturnType<typeof createDrizzleRepositories>

/** Truthy env flag (`true`/`1`/`yes`). */
function isTruthy(value: string | undefined): boolean {
  return value === 'true' || value === '1' || value === 'yes'
}

/**
 * Wire the Slack integration when enabled: the notification *channel* (an extra
 * delivery transport composed onto the notification mechanism — Node has no in-app
 * channel, so this is its only one) plus the management repositories (per-account
 * connect + per-workspace routing + member map) and the bot-token cipher. The
 * per-account bot token is sealed with the shared ENCRYPTION_KEY under a
 * slack-scoped HKDF info, mirroring the Worker. OAuth credentials are optional.
 */
function selectNodeSlackDeps(
  config: AppConfig,
  repos: NodeRepositories,
  // The remote-source seam (mothership mode): `sourced('name', build)` returns the remote registry
  // entry when there's no `db`, else builds the Drizzle repo. Routing the three Slack repos through
  // it makes the connect / route / member-map management surface functional in mothership mode —
  // AND keeps the `SlackNotificationChannel` (which captures these repos directly) reading the SAME
  // remote-backed repos, so it can't drift to the broken db-less Drizzle instances. The bot token
  // rides a SEALED `tokenCipher` (sealed/decrypted under the LOCAL key), so the sealed blob — never
  // plaintext — crosses the machine API; the settings + member-mapping rows carry no secrets. The
  // RPC allow-list gates each method by its account/workspace scope. (Mothership-SIDE delivery for a
  // hosted teammate's notification — the mothership decrypting a laptop-sealed token — is the later
  // secrets-delegation slice; local delivery, where the run's own node holds the key, works.)
  sourced: <T>(name: string, build: (d: DrizzleDb) => T) => T,
): Partial<CoreDependencies> {
  if (!config.slack.enabled || !config.slack.encryptionKey) return {}
  const secretCipher = new WebCryptoSecretCipher({
    masterKeyBase64: config.slack.encryptionKey,
    info: SLACK_CIPHER_INFO,
  })
  const slackConnectionRepository = sourced(
    'slackConnectionRepository',
    (d) => new DrizzleSlackConnectionRepository(d),
  )
  const slackSettingsRepository = sourced(
    'slackSettingsRepository',
    (d) => new DrizzleSlackSettingsRepository(d),
  )
  const slackMemberMappingRepository = sourced(
    'slackMemberMappingRepository',
    (d) => new DrizzleSlackMemberMappingRepository(d),
  )
  return {
    notificationChannel: new SlackNotificationChannel({
      workspaceRepository: repos.workspaceRepository,
      slackConnectionRepository,
      slackSettingsRepository,
      slackMemberMappingRepository,
      blockRepository: repos.blockRepository,
      secretCipher,
      // Best-effort delivery still surfaces failures (revoked token, missing channel
      // invite) through the structured logger so a broken route is diagnosable.
      onError: (error, ctx) =>
        logger.warn('slack notification delivery failed', {
          err: error instanceof Error ? error.message : String(error),
          ...ctx,
        }),
    }),
    slackConnectionRepository,
    slackSettingsRepository,
    slackMemberMappingRepository,
    slackSecretCipher: secretCipher,
  }
}

/** Inputs {@link buildNodeRealtimeDeps} needs from the composition root. */
export interface NodeRealtimeDepsInput {
  env: NodeJS.ProcessEnv
  config: AppConfig
  repos: NodeRepositories
  sourced: <T>(name: string, build: (d: DrizzleDb) => T) => T
  realtimeSink?: LocalEventSink
  standardAgentExecutor: CompositeAgentExecutor
  modelProviderResolver: ModelProviderResolver
  resolveWorkspaceModelDefault: (
    workspaceId: string,
    agentKind: string,
    modelPresetId?: string,
  ) => Promise<string | undefined>
  agentKindRegistry: AgentKindRegistry
  clock: Clock
  /**
   * Extra delivery channels contributed by a downstream facade, composed alongside the ones built
   * here. Local mode in mothership mode contributes its `RemoteNotificationChannel` (the org's
   * external transports live on the mothership), so a laptop-raised notification still reaches
   * the team's Slack. Empty/absent on a stock Node deployment.
   */
  extraNotificationChannels?: NotificationChannel[]
}

/**
 * Build the outbound notification-webhook feature (management service + delivery channel) when the
 * shared encryption key is present — the signing secret must be sealable. Both halves come from
 * ONE builder so they can't drift onto different repositories/ciphers. The repository rides the
 * `sourced` seam like the Slack repos, so mothership mode reads the same remote-backed rows.
 * Null when no key is set; then the management surface 503s and no deliveries are attempted.
 */
function selectNodeNotificationWebhookSupport(
  env: NodeJS.ProcessEnv,
  config: AppConfig,
  clock: Clock,
  sourced: <T>(name: string, build: (d: DrizzleDb) => T) => T,
): ReturnType<typeof buildNotificationWebhookSupport> | null {
  // Read the shared key straight off the env, exactly as the Worker's builder does — the Node
  // config splits ENCRYPTION_KEY into per-feature sub-configs, and inventing another one here
  // would make the two facades gate this feature on different conditions.
  const encryptionKey = env.ENCRYPTION_KEY?.trim()
  if (!encryptionKey) return null
  // The endpoint guard, resolved from the webhook's OWN config slice (undefined ⇒ the strict
  // public-https default). Handed to the builder, which gives it to both the write boundary and
  // the delivery path so they can't admit/reject different endpoints. Symmetric with the Worker.
  const urlSafetyPolicy = resolveUrlSafetyPolicy(config.notificationWebhooks)
  return buildNotificationWebhookSupport({
    ...(urlSafetyPolicy ? { urlSafetyPolicy } : {}),
    notificationWebhookRepository: sourced(
      'notificationWebhookRepository',
      (d) => new DrizzleNotificationWebhookRepository(d),
    ),
    secretCipher: new WebCryptoSecretCipher({
      masterKeyBase64: encryptionKey,
      info: NOTIFICATION_WEBHOOK_CIPHER_INFO,
    }),
    clock,
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

/**
 * The real-time event-publisher + notification-channel + optional consensus wrap of the Node
 * composition root, lifted out of `buildNodeContainer` so that root stays within the file-size
 * budget. Builds the Slack deps, the fan-out event publisher (when a realtime hub is wired),
 * the (optionally consensus-wrapped) agent executor, and the composite notification channel.
 */
export function buildNodeRealtimeDeps(input: NodeRealtimeDepsInput) {
  const {
    env,
    config,
    repos,
    sourced,
    realtimeSink,
    standardAgentExecutor,
    modelProviderResolver,
    resolveWorkspaceModelDefault,
    agentKindRegistry,
    clock,
    extraNotificationChannels,
  } = input

  // Real-time push + notification delivery. When a realtime hub is wired (start()), the
  // engine pushes execution/board/notification events to subscribed browsers via the
  // NodeEventPublisher, decorated with FanOutEventPublisher so a shared service's live
  // events reach EVERY board that mounts it (parity with the Worker's selectEventPublisher).
  // The in-app push is also a notification channel, composed alongside Slack (when
  // enabled) so a raised notification both lands in the inbox live AND fans to Slack.
  const slackDeps = selectNodeSlackDeps(config, repos, sourced)
  const notificationWebhookSupport = selectNodeNotificationWebhookSupport(
    env,
    config,
    clock,
    sourced,
  )
  const executionEventPublisher = realtimeSink
    ? new FanOutEventPublisher(new NodeEventPublisher(realtimeSink), {
        workspaceMountRepository: repos.workspaceMountRepository,
      })
    : undefined
  // Optionally wrap the executor with the consensus mechanism (CONSENSUS_ENABLED). Off ⇒
  // the standard composite, unchanged. Registers the capability traits + routes
  // consensus-enabled steps through a multi-model process, persisting + pushing the
  // transcript (same hub as run/board events).
  const agentExecutor: AgentExecutor = isTruthy(env.CONSENSUS_ENABLED)
    ? (registerConsensusTraits(agentKindRegistry),
      new ConsensusAgentExecutor({
        standard: standardAgentExecutor,
        modelProviderResolver,
        agentRouting: config.agents.routing,
        resolveBlockModel: config.agents.resolveBlockModel,
        resolveWorkspaceModelDefault,
        // Consensus runs its participants INLINE, so in local mode keep an ambient-eligible
        // subscription harness ref (served via the CLI) instead of degrading it; undefined on
        // stock Node/Worker, where such a ref degrades to the routing default as before.
        ...(config.agents.inlineHarnessRef ? { runsInline: config.agents.inlineHarnessRef } : {}),
        sessionRepository: repos.consensusSessionRepository,
        ...(executionEventPublisher ? { eventPublisher: executionEventPublisher } : {}),
        agentKindRegistry,
      }))
    : standardAgentExecutor

  // EXTERNAL channels = everything that is not the in-app push. They are what a mothership
  // delivers on behalf of a mothership-mode node (`machineNotificationDelivery`), because they are
  // the ones whose credentials never leave the mothership; the in-app frame for a laptop-raised
  // notification already rides the real-time upstream relay, so it must NOT be delivered twice.
  const externalNotificationChannels: NotificationChannel[] = [
    ...(slackDeps.notificationChannel ? [slackDeps.notificationChannel] : []),
    // The outbound webhook is what a HEADLESS caller relies on: it has no in-app inbox and no
    // browser WebSocket, so a parked run would otherwise reach it only by polling (see
    // docs/initiatives/headless-clarification-loop.md). Symmetric with the Worker.
    //
    // It belongs in the EXTERNAL set by the definition above — it is not the in-app push, and its
    // signing secret is sealed with the deployment key. That placement is what makes it work under
    // mothership mode: the row and its sealed secret live on the mothership, so the mothership is
    // the only side that can decrypt and deliver it. Composing it only into the local fan-out
    // would leave a laptop failing every delivery on a decrypt it cannot perform while the
    // mothership never attempted one.
    ...(notificationWebhookSupport ? [notificationWebhookSupport.channel] : []),
    ...(extraNotificationChannels ?? []),
  ]
  const notificationChannels: NotificationChannel[] = []
  if (executionEventPublisher)
    notificationChannels.push(new InAppNotificationChannel(executionEventPublisher))
  notificationChannels.push(...externalNotificationChannels)

  return {
    slackDeps,
    executionEventPublisher,
    agentExecutor,
    notificationChannel: composeChannels(notificationChannels),
    externalNotificationChannel: composeChannels(externalNotificationChannels),
    notificationWebhookSupport,
  }
}

/** One channel as-is, several fanned out, none ⇒ undefined (the port is simply not wired). */
function composeChannels(channels: NotificationChannel[]): NotificationChannel | undefined {
  if (channels.length === 0) return undefined
  return channels.length === 1 ? channels[0] : new CompositeNotificationChannel(channels)
}
