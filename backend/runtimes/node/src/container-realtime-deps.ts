import { type AgentKindRegistry } from '@cat-factory/agents'
import { ConsensusAgentExecutor, registerConsensusTraits } from '@cat-factory/consensus'
import { SLACK_CIPHER_INFO, SlackNotificationChannel } from '@cat-factory/integrations'
import {
  type AgentExecutor,
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
} from '@cat-factory/server'
import type { DrizzleDb } from './db/client.js'
import { type LocalEventSink, NodeEventPublisher } from './realtime.js'
import type { createDrizzleRepositories } from './repositories/drizzle.js'
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
        logger.warn(
          { err: error instanceof Error ? error.message : String(error), ...ctx },
          'slack notification delivery failed',
        ),
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
  } = input

  // Real-time push + notification delivery. When a realtime hub is wired (start()), the
  // engine pushes execution/board/notification events to subscribed browsers via the
  // NodeEventPublisher, decorated with FanOutEventPublisher so a shared service's live
  // events reach EVERY board that mounts it (parity with the Worker's selectEventPublisher).
  // The in-app push is also a notification channel, composed alongside Slack (when
  // enabled) so a raised notification both lands in the inbox live AND fans to Slack.
  const slackDeps = selectNodeSlackDeps(config, repos, sourced)
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

  const notificationChannels: NotificationChannel[] = []
  if (executionEventPublisher)
    notificationChannels.push(new InAppNotificationChannel(executionEventPublisher))
  if (slackDeps.notificationChannel) notificationChannels.push(slackDeps.notificationChannel)
  const notificationChannel =
    notificationChannels.length === 0
      ? undefined
      : notificationChannels.length === 1
        ? notificationChannels[0]
        : new CompositeNotificationChannel(notificationChannels)

  return { slackDeps, executionEventPublisher, agentExecutor, notificationChannel }
}
