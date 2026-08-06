import {
  type Clock,
  CompositeNotificationChannel,
  type DocumentSourceProvider,
  type EmailSender,
  type ExecutionEventPublisher,
  type GitHubClient,
  type IdGenerator,
  type NotificationChannel,
  NoopWorkRunner,
  type TaskSourceProvider,
  type VcsIdentityRegistry,
  type WorkRunner,
  type ProviderRegistry,
} from '@cat-factory/kernel'
import { createTierInstallationResolvers } from '@cat-factory/agents'
import {
  ConfluenceProvider,
  FigmaProvider,
  ZeplinProvider,
  GitHubDocsProvider,
  GitHubIssuesProvider,
  JiraProvider,
  LinearDocumentProvider,
  LinearTaskProvider,
  NotionProvider,
  EMAIL_CIPHER_INFO,
  ProvisioningLogRecorder,
  OBSERVABILITY_CIPHER_INFO,
  RegistryReleaseHealthProvider,
  defaultObservabilityRegistry,
  WorkspaceIncidentEnrichmentProvider,
  INCIDENT_ENRICHMENT_CIPHER_INFO,
  createEmailSender,
} from '@cat-factory/integrations'
// Opt-in AWS EKS backends (runner + environment), registered by reference on BOTH facades so
// the runtimes stay symmetric with the native `kubernetes` backend they extend (which likewise
// rides both). They are pass-throughs until a workspace connects an `eks` backend, and carry NO
// runtime AWS SDK dependency (the IAM token is minted with WebCrypto, which workerd supports).
// A real EKS cluster's private-CA apiserver is only reachable from a runtime that can pin a
// custom CA (Node/local) — exactly like a private-CA `kubernetes` connection — so on the Worker
// the kind is offered but a connection to such a cluster fails TLS at run time, not silently.
import { resolveWorkerRegistries } from './container-registries.js'
import { selectTraceSink } from './container-trace-sinks.js'
export { selectTraceSink }
import { buildWorkerSharedServices } from './container-shared-services.js'
import { assembleWorkerContainer } from './container-assembly.js'
import {
  registeredToolSecretEnvironmentFallback,
  resolveRegisteredToolSecretResolver,
} from './toolSecretResolver.js'
import {
  buildAppRegistry,
  buildResolveRepoTarget,
  buildResolveRepoTargets,
  buildResolveRunInitiatorToken,
} from './container-vcs-identity.js'
// The App registry + repo-target resolvers moved to `container-vcs-identity.ts`; re-exported so
// the sibling modules that already read them off the composition root keep one import surface.
export { buildAppRegistry, buildResolveRepoTarget }
import { buildModelProviderResolver } from './container-model-resolver.js'
import {
  buildResolveTransport,
  maybeWrapConsensus,
  selectAgentExecutor,
} from './container-executor-deps.js'
// The executor wiring moved to `container-executor-deps.ts`; re-exported so
// `container-assembly.ts` keeps importing the composition root's public surface from one place.
export { maybeWrapConsensus, selectAgentExecutor }
export type { WorkerExecutorDeps } from './container-executor-deps.js'
import {
  type CoreDependencies,
  PACKAGE_REGISTRY_CIPHER_INFO,
  resolvePackageRegistriesForDispatch,
} from '@cat-factory/orchestration'
import { ISOLATE_SAFE_APP_CACHES_PROFILE, createAppCaches } from '@cat-factory/caching'
import {
  makeResolveDeployCloneTarget,
  RunnerJobClient,
  FanOutEventPublisher,
  InAppNotificationChannel,
  PatPreferringAppRegistry,
  buildToolSecretChain,
  buildDispatchTokenMint,
  type GitHubAppRegistry,
  type MintInstallationToken,
  logger,
  buildInfrastructureCapabilities,
  GitHubIdentityResolver,
  resolveUrlSafetyPolicy,
  type JobPackageRegistrySpec,
  type ServerContainer,
  operationalMetrics,
} from '@cat-factory/server'
import { type AppConfig, loadConfig } from './config'
import type { Env } from './env'
import { requireDb, requireTelemetryDb } from './env'
import { CloudflareContainerTransport } from './containers/CloudflareContainerTransport'
import { HttpRunnerPoolProvider } from './runners/HttpRunnerPoolProvider'
import { D1RunnerPoolConnectionRepository } from './repositories/D1RunnerPoolConnectionRepository'
import { DurableObjectEventPublisher } from './events/DurableObjectEventPublisher'
import { WorkflowsWorkRunner } from './workflows/WorkflowsWorkRunner'
import { D1BlockRepository } from './repositories/D1BlockRepository'
import { D1WorkspaceMountRepository } from './repositories/D1WorkspaceMountRepository'
import { D1ProvisioningLogRepository } from './repositories/D1ProvisioningLogRepository'
import { D1WorkspaceRepository } from './repositories/D1WorkspaceRepository'
import { D1AccountInvitationRepository } from './repositories/D1AccountInvitationRepository'
import { D1PasswordResetTokenRepository } from './repositories/D1PasswordResetTokenRepository'
import { D1EmailConnectionRepository } from './repositories/D1EmailConnectionRepository'
import { D1GitHubInstallationRepository } from './repositories/D1GitHubInstallationRepository'
import { D1RateLimitRepository } from './repositories/D1RateLimitRepository'
import { D1DocumentConnectionRepository } from './repositories/D1DocumentConnectionRepository'
import { D1DocumentRepository } from './repositories/D1DocumentRepository'
import { D1EnvironmentConnectionRepository } from './repositories/D1EnvironmentConnectionRepository'
import { D1CustomManifestTypeRepository } from './repositories/D1CustomManifestTypeRepository'
import { D1EnvironmentRegistryRepository } from './repositories/D1EnvironmentRegistryRepository'
import { D1RequirementReviewRepository } from './repositories/D1RequirementReviewRepository'
import { D1DocInterviewRepository } from './repositories/D1DocInterviewRepository'
import { D1KaizenGradingRepository } from './repositories/D1KaizenGradingRepository'
import { D1KaizenVerifiedComboRepository } from './repositories/D1KaizenVerifiedComboRepository'
import { D1ConsensusGroupRepository } from './repositories/D1ConsensusGroupRepository'
import { D1ClarityReviewRepository } from './repositories/D1ClarityReviewRepository'
import { D1BrainstormSessionRepository } from './repositories/D1BrainstormSessionRepository'
import { D1NotificationRepository } from './repositories/D1NotificationRepository'
import { D1InitiativeRepository } from './repositories/D1InitiativeRepository'
import { D1MergeTrackRecordRepository } from './repositories/D1MergeTrackRecordRepository'
import { D1RiskPolicyRepository } from './repositories/D1RiskPolicyRepository'
import { D1SharedStackRepository } from './repositories/D1SharedStackRepository'
import {
  D1SandboxPromptVersionRepository,
  D1SandboxFixtureRepository,
  D1SandboxExperimentRepository,
  D1SandboxRunRepository,
  D1SandboxGradeRepository,
} from './repositories/D1SandboxRepositories'
import { D1WorkspaceSettingsRepository } from './repositories/D1WorkspaceSettingsRepository'
import { selectPerUserDeps } from './container-per-user-deps'
import { D1ObservabilityConnectionRepository } from './repositories/D1ObservabilityConnectionRepository'
import { D1PackageRegistryConnectionRepository } from './repositories/D1PackageRegistryConnectionRepository'

import { D1IncidentEnrichmentConnectionRepository } from './repositories/D1IncidentEnrichmentConnectionRepository'
import { D1ReleaseHealthConfigRepository } from './repositories/D1ReleaseHealthConfigRepository'
import { D1AgentPromptRepository } from './repositories/D1AgentPromptRepository'
import { D1WorkspaceAgentSettingsRepository } from './repositories/D1WorkspaceAgentSettingsRepository'
import { D1ModelPresetRepository } from './repositories/D1ModelPresetRepository'
import { D1ServiceFragmentDefaultsRepository } from './repositories/D1ServiceFragmentDefaultsRepository'
// The built-in polling-gate suite (ci / conflicts / post-release-health + on-call). The facade
// builds an app-owned `GateRegistry` pre-loaded with the suite via `gateRegistryWithBuiltins()`,
// then wires each gate's provider below.
import {
  type GateProviderOverrides,
  wireCiStatusProvider,
  wireMergeabilityProvider,
  wireReleaseHealthProvider,
  wireIncidentEnrichment,
  wirePullRequestReviewProvider,
  wireDocQualityProvider,
} from '@cat-factory/gates'
import {
  buildGitLabEngineClient,
  GitLabIdentityResolver,
  registerGitLab,
  StaticGitLabTokenSource,
} from '@cat-factory/gitlab'
import {
  GitHubDocQualityProvider,
  GitHubPrReportPublisher,
  GitHubPullRequestReviewProvider,
} from '@cat-factory/server'
import { GitHubCiStatusProvider } from './github/GitHubCiStatusProvider'
import { GitHubMergeabilityProvider } from './github/GitHubMergeabilityProvider'
import { GitHubBranchUpdater } from './github/GitHubBranchUpdater'
import { GitHubPullRequestMerger } from './github/GitHubPullRequestMerger'
import { WebCryptoSecretCipher } from './environments/WebCryptoSecretCipher'
import { FetchGitHubClient } from './github/FetchGitHubClient'
import { D1TaskConnectionRepository } from './repositories/D1TaskConnectionRepository'
import { D1TaskSourceSettingsRepository } from './repositories/D1TaskSourceSettingsRepository'
import { D1TaskRepository } from './repositories/D1TaskRepository'
import { D1TrackerCommentIngestRepository } from './repositories/D1TrackerCommentIngestRepository'
import { D1FragmentBriefRepository } from './repositories/D1FragmentBriefRepository'
import { D1PromptFragmentRepository } from './repositories/D1PromptFragmentRepository'
import { D1FragmentSourceRepository } from './repositories/D1FragmentSourceRepository'
import { D1AccountSkillRepository } from './repositories/D1AccountSkillRepository'
import { D1SkillSourceRepository } from './repositories/D1SkillSourceRepository'
import {
  D1ApiContractRepository,
  D1FoundationalServiceRepository,
  D1FoundationalServiceSourceRepository,
} from './repositories/D1FoundationalServiceRepository'
import { LlmFragmentSelector } from './ai/LlmFragmentSelector'
import { CryptoIdGenerator, SystemClock } from './runtime'
import type { D1Database } from '@cloudflare/workers-types'

// The infrastructure composition root: turn a Worker `env` into the concrete
// ports (D1 repositories, runtime, the chosen agent executor) and assemble the
// domain core. Built once per request — instantiation is cheap and each request
// gets its own D1 handle from `env`.

// The Worker's container shape is exactly the shared one (domain Core + resolved
// config + the kind-spanning agent-run repository); the type lives in the shared
// package so the cross-runtime controllers can reference it.
export type Container = ServerContainer

/**
 * Build the merge-lifecycle ports. The notification repository + merge-preset
 * repository are wired unconditionally (the inbox + presets are always available);
 * the in-app delivery channel is wired only when the events binding is present
 * (else rows persist but nothing is pushed). The CI status provider + PR merger
 * need GitHub, so they're wired only when the App is configured — without them the
 * `ci` gate passes through and `done` is a board-only flip (graceful degradation).
 */
/**
 * The GitHubClient the engine's gate / merge / RepoFiles paths read through: the GitHub App
 * (preferring the run initiator's per-user PAT when stored), else a GitLab-backed single-token
 * client (bridged onto the GitHubClient port). Undefined when neither is configured — the gates
 * then pass through. Shared by the merge-lifecycle and RepoFiles wiring so they resolve the SAME
 * provider, and so the GitLab fallback can't drift from the App path.
 */
function selectEngineVcsClient(
  env: Env,
  config: AppConfig,
  db: D1Database,
  clock: Clock,
  idGenerator: IdGenerator,
): GitHubClient | undefined {
  if (config.github.enabled && env.GITHUB_APP_PRIVATE_KEY) {
    const baseRegistry = buildAppRegistry(env, config, db, clock)
    // Prefer the run initiator's per-user PAT (when stored AND the workspace permits it) over
    // the App token for the CI gate + merge reads; the engine sets the run's credential scope
    // in ambient context around those boundaries (runWithInitiator). Falls back to the App
    // token otherwise.
    const resolveRunInitiatorToken = buildResolveRunInitiatorToken(env, db, clock)
    const registry = resolveRunInitiatorToken
      ? new PatPreferringAppRegistry(baseRegistry, resolveRunInitiatorToken)
      : baseRegistry
    return new FetchGitHubClient({
      registry,
      rateLimitRepository: new D1RateLimitRepository({ db, idGenerator }),
      idGenerator,
      clock,
      apiBase: config.github.apiBase,
    })
  }
  if (config.gitlab?.enabled && env.GITLAB_TOKEN) {
    return buildGitLabEngineClient({
      token: env.GITLAB_TOKEN,
      apiBase: config.gitlab.apiBase,
      clock,
      logger,
    })
  }
  return undefined
}

/** What {@link selectMergeLifecycleDeps} needs. An options object rather than a positional tail:
 *  it already carried six parameters, and the notification channels it composes will keep
 *  growing (in-app, Slack, the outbound webhook, …) — a named bag stays readable and keeps the
 *  call site honest about which of the several same-typed handles is which. */
export interface MergeLifecycleDepsInput {
  env: Env
  config: AppConfig
  db: D1Database
  clock: Clock
  idGenerator: IdGenerator
  providerRegistry: ProviderRegistry
  /**
   * The outbound notification-webhook delivery channel, when the deployment configured one. Built
   * by the caller (alongside its management service, from ONE builder) so both halves are
   * guaranteed to read the same rows through the same cipher.
   */
  webhookChannel?: NotificationChannel
}

export function selectMergeLifecycleDeps(
  input: MergeLifecycleDepsInput,
): Partial<CoreDependencies> {
  const { env, config, db, clock, idGenerator, providerRegistry, webhookChannel } = input
  const deps: Partial<CoreDependencies> = {
    // This Worker's own externally-reachable URL — the same value the container harness reaches
    // the LLM proxy on. The verification report builds direct links to captured artifacts' bytes
    // from it; unset ⇒ the report lists artifact ids with no link, never a link to nowhere.
    apiBaseUrl: env.WORKER_PUBLIC_URL?.trim() || undefined,
    notificationRepository: new D1NotificationRepository({ db }),
    riskPolicyRepository: new D1RiskPolicyRepository({ db }),
    mergeTrackRecordRepository: new D1MergeTrackRecordRepository({ db }),
    // Shared stacks (long-lived compose infra a consumer environment attaches to). CRUD +
    // persistence are runtime-symmetric; the Worker never brings a stack UP (no host daemon),
    // so no `composeRuntime` is wired here — the lifecycle endpoints report "not supported".
    sharedStackRepository: new D1SharedStackRepository({ db }),
    workspaceSettingsRepository: new D1WorkspaceSettingsRepository({ db }),
    ...selectPerUserDeps(db),
    modelPresetRepository: new D1ModelPresetRepository({ db }),
    // The consensus-GROUP library: the estimate-gated panels a pipeline step escalates to.
    // Always wired (no secret material) — the panels only run when the optional consensus
    // executor is enabled, but the library is editable and snapshot-visible regardless.
    consensusGroupRepository: new D1ConsensusGroupRepository({ db }),
    agentPromptRepository: new D1AgentPromptRepository({ db }),
    workspaceAgentSettingsRepository: new D1WorkspaceAgentSettingsRepository({ db }),
    serviceFragmentDefaultsRepository: new D1ServiceFragmentDefaultsRepository({ db }),
    initiativeRepository: new D1InitiativeRepository({ db }),
  }
  // Compose the delivery channels: in-app push (when the events binding is present), Slack (when
  // the integration is enabled) and the outbound webhook (when a workspace registered one) all
  // implement the same NotificationChannel port and fan out via CompositeNotificationChannel —
  // realizing the seam the kernel port documents, with no change to the engine call sites that
  // raise notifications. The webhook channel is what a HEADLESS caller relies on: it has no
  // in-app inbox and no browser WebSocket, so a parked run would otherwise reach it only by
  // polling (see docs/initiatives/headless-clarification-loop.md).
  const channels: NotificationChannel[] = []
  const publisher = selectEventPublisher(env, db)
  if (publisher) channels.push(new InAppNotificationChannel(publisher))
  const externalChannel = buildExternalNotificationChannel(config, db, webhookChannel)
  if (externalChannel) channels.push(externalChannel)
  if (channels.length === 1) deps.notificationChannel = channels[0]
  else if (channels.length > 1)
    deps.notificationChannel = new CompositeNotificationChannel(channels)

  // The engine's CI gate + merge / mergeability / review providers read through a single
  // GitHubClient. Prefer the GitHub App; else fall back to a GitLab-backed client (single-token,
  // bridged onto the GitHubClient port) so a GitLab-only deployment gates on real CI and merges
  // for real — parity with the App path and with local mode (keep the runtimes symmetric).
  const githubClient = selectEngineVcsClient(env, config, db, clock, idGenerator)
  if (githubClient) {
    const resolveRepoTarget = buildResolveRepoTarget(db)
    const blockRepository = new D1BlockRepository({ db })
    // The `ci` / `conflicts` gates now live in `@cat-factory/gates`; wire their providers into
    // the gate suite (deployment-global handles) instead of onto the engine's CoreDependencies.
    wireCiStatusProvider(
      providerRegistry,
      new GitHubCiStatusProvider({ githubClient, resolveRepoTarget, blockRepository }),
    )
    wireMergeabilityProvider(
      providerRegistry,
      new GitHubMergeabilityProvider({ githubClient, resolveRepoTarget, blockRepository }),
    )
    wirePullRequestReviewProvider(
      providerRegistry,
      new GitHubPullRequestReviewProvider({ githubClient, resolveRepoTarget, blockRepository }),
    )
    wireDocQualityProvider(
      providerRegistry,
      new GitHubDocQualityProvider({
        githubClient,
        resolveRepoTarget,
        blockRepository,
        // The gate resolves a workspace-linked template (WS1) for the block's kind, so it checks
        // against the SAME sections the doc-writer followed. Cheap query wrapper over the same D1.
        documentRepository: new D1DocumentRepository({ db }),
      }),
    )
    deps.branchUpdater = new GitHubBranchUpdater({
      githubClient,
      resolveRepoTarget,
      blockRepository,
    })
    deps.pullRequestMerger = new GitHubPullRequestMerger({
      githubClient,
      resolveRepoTarget,
      blockRepository,
    })
    // Keeps the engine-maintained verification report current on every pull request the run
    // opened — the own-service one plus each peer repo's on a cross-service task. Reads through
    // the same engine VCS client, so a GitLab-only deployment gets it too (runtime symmetry
    // with the Node facade's `githubGateDeps`).
    deps.prVerificationReportPublisher = new GitHubPrReportPublisher({
      githubClient,
      resolveRepoTarget,
      resolveRepoTargets: buildResolveRepoTargets(db),
      blockRepository,
      logger,
    })
  }
  return deps
}

/**
 * Wire the observability post-release-health gate when enabled (+ ENCRYPTION_KEY): the
 * connection + per-block config repos, the cipher that seals the credentials, the pluggable
 * release-health provider the gate probes (a registry of vendor adapters — Datadog today),
 * and (optionally) the PagerDuty / incident.io enrichment providers. Off → the gate is a
 * pass-through and the release-health module isn't built.
 */
export function selectReleaseHealthDeps(
  env: Env,
  config: AppConfig,
  db: D1Database,
  providerRegistry: ProviderRegistry,
): Partial<CoreDependencies> {
  if (!config.releaseHealth.enabled || !config.releaseHealth.encryptionKey) return {}
  const observabilityConnectionRepository = new D1ObservabilityConnectionRepository({ db })
  const releaseHealthConfigRepository = new D1ReleaseHealthConfigRepository({ db })
  const observabilitySecretCipher = new WebCryptoSecretCipher({
    masterKeyBase64: config.releaseHealth.encryptionKey,
    info: OBSERVABILITY_CIPHER_INFO,
  })
  // The post-release-health gate + its on-call escalation now live in `@cat-factory/gates`;
  // wire their providers into the gate suite (deployment-global handles). The observability
  // connection/config repos + cipher stay on CoreDependencies — they power the management API
  // (ReleaseHealthService), not the gate.
  wireReleaseHealthProvider(
    providerRegistry,
    new RegistryReleaseHealthProvider({
      observabilityConnectionRepository,
      releaseHealthConfigRepository,
      blockRepository: new D1BlockRepository({ db }),
      secretCipher: observabilitySecretCipher,
      registry: defaultObservabilityRegistry(),
    }),
  )
  return {
    observabilityConnectionRepository,
    releaseHealthConfigRepository,
    observabilitySecretCipher,
  }
}

/**
 * Wire the per-workspace private package-registry integration (npm private orgs, GitHub
 * Packages). Wired whenever the shared encryption key is present (the cipher must exist
 * to seal/unseal); a workspace with no entries is a no-op. The decrypted entries reach
 * agent containers via the executor's `resolvePackageRegistries` seam.
 */
export function selectPackageRegistryDeps(env: Env, db: D1Database): Partial<CoreDependencies> {
  const encryptionKey = env.ENCRYPTION_KEY?.trim()
  if (!encryptionKey) return {}
  return {
    packageRegistryConnectionRepository: new D1PackageRegistryConnectionRepository({ db }),
    packageRegistrySecretCipher: new WebCryptoSecretCipher({
      masterKeyBase64: encryptionKey,
      info: PACKAGE_REGISTRY_CIPHER_INFO,
    }),
  }
}

/**
 * The agent executor / bootstrapper `resolvePackageRegistries` seam: decrypt the
 * workspace's private-registry entries onto the job body at dispatch. Built over the
 * same repo + cipher the management API uses; undefined when the encryption key is
 * absent (no registry auth is forwarded).
 */
export function buildResolvePackageRegistries(
  env: Env,
  db: D1Database,
): ((workspaceId: string) => Promise<JobPackageRegistrySpec[]>) | undefined {
  const encryptionKey = env.ENCRYPTION_KEY?.trim()
  if (!encryptionKey) return undefined
  const repository = new D1PackageRegistryConnectionRepository({ db })
  const cipher = new WebCryptoSecretCipher({
    masterKeyBase64: encryptionKey,
    info: PACKAGE_REGISTRY_CIPHER_INFO,
  })
  return (workspaceId) => resolvePackageRegistriesForDispatch(repository, cipher, workspaceId)
}

/**
 * Wire the per-workspace incident-enrichment integration (PagerDuty + incident.io). The
 * credentials moved out of env into a sealed per-workspace row; the provider resolves +
 * decrypts them at enrichment time. Wired whenever the shared encryption key is present
 * (the cipher must exist to unseal); a workspace with no connection is a no-op. The
 * on-call enrichment provider itself now lives in `@cat-factory/gates`, so the
 * workspace-backed provider is wired into the gate suite via `wireIncidentEnrichment`;
 * the connection repo + cipher stay on CoreDependencies to power the management API.
 */
export function selectIncidentEnrichmentDeps(
  env: Env,
  db: D1Database,
  providerRegistry: ProviderRegistry,
): Partial<CoreDependencies> {
  const encryptionKey = env.ENCRYPTION_KEY?.trim()
  if (!encryptionKey) return {}
  const incidentEnrichmentConnectionRepository = new D1IncidentEnrichmentConnectionRepository({
    db,
  })
  const incidentEnrichmentSecretCipher = new WebCryptoSecretCipher({
    masterKeyBase64: encryptionKey,
    info: INCIDENT_ENRICHMENT_CIPHER_INFO,
  })
  wireIncidentEnrichment(
    providerRegistry,
    new WorkspaceIncidentEnrichmentProvider({
      incidentEnrichmentConnectionRepository,
      secretCipher: incidentEnrichmentSecretCipher,
    }),
  )
  return {
    incidentEnrichmentConnectionRepository,
    incidentEnrichmentSecretCipher,
  }
}

// The per-account deployment-settings builder lives in its own LEAF module: this file imports
// both `container-shared-services` and `container-artifact-storage`, and both needed it — an
// import cycle that only a hoisted function declaration was papering over. Re-exported here so
// every existing import site is unchanged.
export { buildAccountSettings } from './container-account-settings'

/**
 * The Worker's content-storage capability + blob-backend factory: on Cloudflare the bytes
 * always go to the deployment's R2 bucket (the only blob store that makes sense on the
 * Worker). `fs`/`db` cannot exist on the Worker, and S3 is intentionally NOT offered here —
 * the AWS SDK does not belong in the Worker bundle, and an account that wants S3 should run
 * the Node/local facade. Shared by the container wiring and the retention cron so both build
 * the same backend.
 */
// The binary-artifact/content-storage wiring lives in its own module (this file is at its size
// ratchet); re-exported here so every existing import site is unchanged.
export {
  buildCloudflareArtifactStoreResolver,
  cloudflareContentStorage,
} from './container-artifact-storage'
import { cloudflareContentStorage } from './container-artifact-storage'
import { buildExternalNotificationChannel } from './container-notification-deps'

/**
 * Wire account invitations + per-account email senders. Invitations are always
 * available (an invite link works without email); the email-connection store + its
 * cipher are wired only when EMAIL is enabled (an encryption key is mandatory), so
 * an account can onboard a SendGrid/Resend key in the UI and have invites emailed.
 */
export function selectEmailInvitationDeps(
  config: AppConfig,
  db: D1Database,
): Partial<CoreDependencies> {
  const deps: Partial<CoreDependencies> = {
    invitationRepository: new D1AccountInvitationRepository({ db }),
    // Password reset works without email (the link is logged in dev); the system
    // sender below upgrades it to real delivery when configured.
    passwordResetTokenRepository: new D1PasswordResetTokenRepository({ db }),
    resolveSystemEmailSender: buildSystemEmailSender(config),
    appBaseUrl: config.email.appBaseUrl || undefined,
    logger,
  }
  if (config.email.enabled && config.email.encryptionKey) {
    deps.emailConnectionRepository = new D1EmailConnectionRepository({ db })
    deps.emailSecretCipher = new WebCryptoSecretCipher({
      masterKeyBase64: config.email.encryptionKey,
      info: EMAIL_CIPHER_INFO,
    })
  }
  return deps
}

/**
 * Build the deployment-level system email sender (auth emails like password reset) from
 * the env-driven `email.system` config, or undefined when not configured. Runtime-neutral
 * (`createEmailSender` is fetch-based), so the Node facade reuses the identical helper.
 */
function buildSystemEmailSender(
  config: AppConfig,
): (() => Promise<EmailSender | null>) | undefined {
  const system = config.email.system
  if (!system) return undefined
  const sender = createEmailSender({
    provider: system.provider,
    from: system.from,
    sendgrid: system.provider === 'sendgrid' ? { apiKey: system.apiKey } : undefined,
    resend: system.provider === 'resend' ? { apiKey: system.apiKey } : undefined,
  })
  if (!sender) return undefined
  return async () => sender
}

/**
 * Pick how runs are driven:
 *   - a Workflows binding present → durable, server-driven execution
 *   - otherwise                   → no-op (e.g. tests, which override this anyway)
 * Tests override `workRunner` with a fake and drive the engine via advanceInstance.
 */
export function selectWorkRunner(env: Env): WorkRunner {
  if (env.EXECUTION_WORKFLOW) {
    return new WorkflowsWorkRunner({
      workflow: env.EXECUTION_WORKFLOW,
      queue: env.EXECUTION_QUEUE,
    })
  }
  return new NoopWorkRunner()
}

/**
 * Pick how execution/board changes are pushed to clients:
 *   - WORKSPACE_EVENTS binding present → fan out via the per-workspace hub DO
 *   - otherwise                        → undefined (core falls back to a no-op)
 * Tests leave the binding unset; the engine simply pushes nothing.
 */
export function selectEventPublisher(
  env: Env,
  db: D1Database,
): ExecutionEventPublisher | undefined {
  if (!env.WORKSPACE_EVENTS) return undefined
  // Fan a shared service's live events out to EVERY workspace that mounts it, not just the
  // one the engine addressed (in-org real-time sharing).
  return new FanOutEventPublisher(new DurableObjectEventPublisher(env.WORKSPACE_EVENTS), {
    workspaceMountRepository: new D1WorkspaceMountRepository({ db }),
  })
}
/**
 * Build the document-source integration's concrete ports: the configured source
 * providers (Confluence, Notion, …) plus the two D1 repositories. The integration is
 * always on (config load fails loudly without the encryption key), so this is wired
 * on every deployment. The model provider is wired only in 'llm' planner mode (it
 * just needs a provider credential); the planner degrades to its deterministic parser
 * if no model is usable.
 */
export function selectDocumentsDeps(
  env: Env,
  config: AppConfig,
  db: D1Database,
  clock: Clock,
  idGenerator: IdGenerator,
): Partial<CoreDependencies> {
  const providers: DocumentSourceProvider[] = []
  if (config.documents.sources.includes('confluence')) providers.push(new ConfluenceProvider())
  if (config.documents.sources.includes('notion')) providers.push(new NotionProvider())
  // Figma + Zeplin authenticate with a per-workspace PAT (no GitHub client needed), like
  // Notion/Confluence.
  if (config.documents.sources.includes('figma')) providers.push(new FigmaProvider())
  if (config.documents.sources.includes('zeplin')) providers.push(new ZeplinProvider())
  if (config.documents.sources.includes('linear')) providers.push(new LinearDocumentProvider())
  // GitHub repo docs reuse the workspace's installed GitHub App, so this provider
  // is wired only when the GitHub integration is also configured — it has no
  // credentials of its own and resolves the installation per file (mirrors the
  // GitHub-issues task source).
  if (config.documents.sources.includes('github') && config.github.enabled) {
    const registry = buildAppRegistry(env, config, db, clock)
    providers.push(
      new GitHubDocsProvider({
        githubClient: new FetchGitHubClient({
          registry,
          rateLimitRepository: new D1RateLimitRepository({ db, idGenerator }),
          idGenerator,
          clock,
          apiBase: config.github.apiBase,
        }),
        installations: new D1GitHubInstallationRepository({ db }),
        logger,
      }),
    )
  }
  if (providers.length === 0) return {}
  return {
    documentSourceProviders: providers,
    documentConnectionRepository: new D1DocumentConnectionRepository({
      db,
      // The config gate guarantees the key is present when enabled; source
      // credentials are encrypted at rest under a documents-scoped HKDF info.
      cipher: new WebCryptoSecretCipher({
        masterKeyBase64: config.documents.encryptionKey!,
        info: 'cat-factory:documents',
      }),
    }),
    documentRepository: new D1DocumentRepository({ db }),
    ...(config.documents.planner === 'llm'
      ? {
          modelProviderResolver: buildModelProviderResolver(env, db),
          documentPlannerModel: config.agents.routing.default.ref,
        }
      : {}),
  }
}

/**
 * Build the task-source integration's concrete ports. Mirrors `selectDocumentsDeps`
 * but with no planner — issues are linked for context, not expanded into board
 * structure. Always on (config load fails loudly without the encryption key), so this
 * is wired on every deployment.
 */
export function selectTasksDeps(
  env: Env,
  config: AppConfig,
  db: D1Database,
  clock: Clock,
  idGenerator: IdGenerator,
): Partial<CoreDependencies> {
  // Jira and Linear are always registered (their credentials are per-workspace, entered in the UI).
  const providers: TaskSourceProvider[] = [new JiraProvider(), new LinearTaskProvider()]
  // GitHub Issues reuse the workspace's installed GitHub App, so this provider is
  // wired whenever the GitHub integration is configured — it has no credentials of
  // its own and resolves the installation per issue. Whether a workspace OFFERS it
  // is the per-workspace toggle (task_source_settings), not a deployment env gate.
  if (config.github.enabled) {
    const registry = buildAppRegistry(env, config, db, clock)
    providers.push(
      new GitHubIssuesProvider({
        githubClient: new FetchGitHubClient({
          registry,
          rateLimitRepository: new D1RateLimitRepository({ db, idGenerator }),
          idGenerator,
          clock,
          apiBase: config.github.apiBase,
        }),
        installations: new D1GitHubInstallationRepository({ db }),
      }),
    )
  }
  return {
    taskSourceProviders: providers,
    taskConnectionRepository: new D1TaskConnectionRepository({
      db,
      // The config gate guarantees the key is present when enabled; source
      // credentials are encrypted at rest under a tasks-scoped HKDF info.
      cipher: new WebCryptoSecretCipher({
        masterKeyBase64: config.tasks.encryptionKey!,
        info: 'cat-factory:tasks',
      }),
    }),
    taskSourceSettingsRepository: new D1TaskSourceSettingsRepository({ db }),
    taskRepository: new D1TaskRepository({ db }),
    // Idempotency markers for INBOUND tracker comments. Wired alongside the task module rather
    // than the writeback, because it guards the INGEST half (a redelivered comment applying its
    // answers twice), which exists only when the task projection does.
    trackerCommentIngestRepository: new D1TrackerCommentIngestRepository({ db }),
  }
}

/**
 * Wire the requirements-review feature. The repository is always available, and a
 * model provider + the agents' default ref are supplied so the stateless reviewer
 * works whenever an LLM is configured — independent of the documents integration.
 * (Supplying the provider here is harmless when documents are off or set to the
 * heading-based planner: that planner only engages when `documentPlannerModel` is
 * also set, which this does not touch.)
 */
export function selectRequirementsDeps(
  env: Env,
  config: AppConfig,
  db: D1Database,
): Partial<CoreDependencies> {
  return {
    requirementReviewRepository: new D1RequirementReviewRepository({ db }),
    docInterviewRepository: new D1DocInterviewRepository({ db }),
    kaizenGradingRepository: new D1KaizenGradingRepository({ db }),
    kaizenVerifiedComboRepository: new D1KaizenVerifiedComboRepository({ db }),
    clarityReviewRepository: new D1ClarityReviewRepository({ db }),
    brainstormSessionRepository: new D1BrainstormSessionRepository({ db }),
    modelProviderResolver: buildModelProviderResolver(env, db),
    // The routing default already resolves to Cloudflare Workers AI unless a
    // direct provider key is set, so the reviewer runs on Cloudflare by default.
    requirementReviewModel: config.agents.routing.default.ref,
    // Honour a block's pinned model with the same direct/Cloudflare fallback the
    // agent executor (and the Pi container path) use.
    requirementReviewResolveModel: config.agents.resolveBlockModel,
  }
}

/**
 * The Sandbox (parallel prompt/model testing) persistence — five repos over the
 * DEDICATED `SANDBOX_DB` D1 database. Opt-in: absent binding ⇒ `{}` (the module isn't
 * assembled and the API answers 503), so a deployment that hasn't provisioned the
 * sandbox database is unaffected. The inline reviewer model config from
 * {@link selectRequirementsDeps} is reused by the run-driver (cells resolve their catalog
 * id like a pipeline step). Mirrored by the Node facade's `createDrizzleSandboxDeps`
 * (a Postgres `sandbox` schema).
 */
export function selectSandboxDeps(sandboxDb: D1Database | undefined): Partial<CoreDependencies> {
  if (!sandboxDb) return {}
  return {
    sandboxPromptVersionRepository: new D1SandboxPromptVersionRepository(sandboxDb),
    sandboxFixtureRepository: new D1SandboxFixtureRepository(sandboxDb),
    sandboxExperimentRepository: new D1SandboxExperimentRepository(sandboxDb),
    sandboxRunRepository: new D1SandboxRunRepository(sandboxDb),
    sandboxGradeRepository: new D1SandboxGradeRepository(sandboxDb),
  }
}

/**
 * Build the ephemeral environment integration's concrete ports. It assembles
 * whenever the encryption key is set (the shared master key that seals per-tenant
 * credentials), so the generic HTTP provider, the D1 repositories and the Web Crypto
 * cipher are wired together. Returns `{}` only when no key is configured, so
 * `createCore` leaves the `environments` module unassembled. There is no separate
 * enable flag: whether a workspace provisions anything is decided by its registered
 * connection + whether its pipeline runs a `deployer`/`tester` step.
 */
export function selectEnvironmentsDeps(
  env: Env,
  config: AppConfig,
  db: D1Database,
): Partial<CoreDependencies> {
  if (!config.environments.encryptionKey) return {}
  // The provider is resolved per-workspace from the env-backend registry by the stored
  // `kind` (`manifest` | `kubernetes` | a third-party kind imported for side effect); a
  // workspace picks its backend at connect time. The Worker can't honor a custom CA /
  // insecure-skip TLS for a Kubernetes apiserver (no undici), so such a config is rejected
  // at registration here.
  const urlPolicy = resolveUrlSafetyPolicy(config.environments)
  return {
    environmentConnectionRepository: new D1EnvironmentConnectionRepository({ db }),
    environmentRegistryRepository: new D1EnvironmentRegistryRepository({ db }),
    // The workspace-defined custom-manifest-type catalog (the UI-editable half of the
    // `custom` provision-type catalog) is a workspace feature on every facade.
    customManifestTypeRepository: new D1CustomManifestTypeRepository({ db }),
    secretCipher: new WebCryptoSecretCipher({
      masterKeyBase64: config.environments.encryptionKey,
    }),
    environmentCustomTlsSupported: false,
    ...(urlPolicy ? { environmentUrlSafetyPolicy: urlPolicy } : {}),
    // Deployment-level, additive extensions to the built-in provisioning-detection conventions.
    ...(config.environments.detectionConventions
      ? { detectionConventions: config.environments.detectionConventions }
      : {}),
  }
}

/**
 * Wire the async, container-backed Kubernetes deploy lifecycle (slice 9's
 * `EnvironmentProvisioningService` seams) onto the Worker facade: a `deployJobClient` that
 * dispatches/polls/releases a `deploy`-kind job on the per-run `DeployContainer` (the separate
 * deploy-harness image — real `kubectl`/`kustomize`/`helm`), plus `resolveDeployCloneTarget` to
 * hand the container concrete manifests-repo clone coords + a short-lived install token.
 *
 * Gated on the environments module, the `DEPLOY_CONTAINER` binding AND the GitHub App
 * (the clone-target seam needs to mint install tokens + resolve a block's repo). Absent any
 * prerequisite ⇒ `{}` — a render-needing config then fails loudly (the synchronous raw-manifest
 * REST path is unaffected), exactly the unwired behaviour slice 9 shipped. Mirrors Node's pool
 * deploy wiring; the deploy container is the Worker's analogue of Node's self-hosted pool.
 */
export function selectDeployDeps(
  env: Env,
  config: AppConfig,
  db: D1Database,
  clock: Clock,
): Partial<CoreDependencies> {
  if (
    !config.environments.encryptionKey ||
    !env.DEPLOY_CONTAINER ||
    !config.github.enabled ||
    !env.GITHUB_APP_PRIVATE_KEY
  ) {
    return {}
  }
  // A deploy-DEDICATED transport: the deploy job's `ref.runId` addresses a `DeployContainer`
  // instance in its own DO namespace (no collision with the agent `EXEC_CONTAINER`), and the
  // harness keys the job by `ref.jobId`. No instance registry is wired (the `sleepAfter` idle
  // timer + explicit `release` reclaim it), so cross-namespace reaping stays the exec
  // container's concern. The client is deploy-only, so `poll`/`release` need no per-ref routing.
  const deployTransport = new CloudflareContainerTransport(
    env.DEPLOY_CONTAINER,
    undefined,
    env.HARNESS_SHARED_SECRET?.trim() || undefined,
  )
  const registry = buildAppRegistry(env, config, db, clock)
  return {
    deployJobClient: new RunnerJobClient(async () => deployTransport),
    // Narrowed to the repo being rendered, like every other container dispatch.
    resolveDeployCloneTarget: makeResolveDeployCloneTarget(
      buildResolveRepoTarget(db),
      workerDispatchTokenMint(registry),
    ),
  }
}

/**
 * Build the self-hosted runner-pool integration's concrete ports when opted in:
 * the D1 connection repository and a dedicated Web Crypto cipher (its own master
 * key + HKDF domain, separate from the environment module's). This assembles
 * `Core.runners` (the connection-management API); the per-job transport selection
 * lives in `buildResolveTransport` above. Returns `{}` when disabled.
 */
export function selectRunnersDeps(
  env: Env,
  config: AppConfig,
  db: D1Database,
): Partial<CoreDependencies> {
  if (!config.runners.enabled) return {}
  const urlPolicy = resolveUrlSafetyPolicy(config.runners)
  return {
    runnerPoolConnectionRepository: new D1RunnerPoolConnectionRepository({ db }),
    runnerSecretCipher: new WebCryptoSecretCipher({
      masterKeyBase64: config.runners.encryptionKey!,
      info: 'cat-factory:runners',
    }),
    // The generic pool provider backs the connection service's describeProvider +
    // testConnection (the manifest editor's secret-key form + a pre-save probe).
    runnerPoolProvider: new HttpRunnerPoolProvider(urlPolicy ? { urlPolicy } : {}),
    // The Worker fetch can't verify a private CA / skip TLS (no undici), so reject a
    // Kubernetes backend that needs custom TLS at registration instead of at dispatch.
    runnerCustomTlsSupported: false,
    ...(urlPolicy ? { runnerUrlSafetyPolicy: urlPolicy } : {}),
  }
}

/**
 * The clone/push credential for a Worker container dispatch: the App registry's mint, narrowed by
 * the shared builder to the repos that dispatch resolved. Every Worker site that hands a container
 * a GitHub token goes through this, so none of them can quietly fall back to an installation-wide
 * one. No `resolveRunInitiatorToken`: the step executor composes its own mint with that chain (see
 * `container-executor-deps.ts`), while bootstrap, repair and the deploy clone have no initiator to
 * act as, and saying so once here beats three call sites each omitting it by accident.
 */
export function workerDispatchTokenMint(registry: GitHubAppRegistry): MintInstallationToken {
  return buildDispatchTokenMint({
    mint: (id, opts) => registry.installationToken(id, opts),
    logger,
    operationalMetrics,
  })
}

/**
 * Build the prompt-fragment library's concrete ports when opted in (ADR 0006):
 * the two D1 repositories, the relevance selector (LLM when configured, else the
 * core deterministic matcher via `fragmentSelector: undefined`), and the
 * installation resolver repo-source sync uses to read guideline repos through the
 * tier's GitHub installation. Returns `{}` when disabled, so `createCore` leaves
 * the `fragmentLibrary` module unassembled and the engine uses manual fragmentIds.
 */
export function selectFragmentLibraryDeps(
  env: Env,
  config: AppConfig,
  db: D1Database,
): Partial<CoreDependencies> {
  if (!config.fragmentLibrary.enabled) return {}
  // The shared tier resolver: workspace tier by direct binding, account tier bound directly
  // (migration 0017) with a fallback through the account's own boards (a per-workspace PAT
  // connect stores no accountId on its installation row).
  const resolvers = createTierInstallationResolvers({
    installations: new D1GitHubInstallationRepository({ db }),
    workspaces: new D1WorkspaceRepository({ db }),
  })
  return {
    promptFragmentRepository: new D1PromptFragmentRepository({ db }),
    fragmentBriefRepository: new D1FragmentBriefRepository({ db }),
    fragmentSourceRepository: new D1FragmentSourceRepository({ db }),
    resolveFragmentInstallationId: resolvers.forOwner,
    ...(config.fragmentLibrary.selector === 'llm'
      ? {
          fragmentSelector: new LlmFragmentSelector({
            modelProviderResolver: buildModelProviderResolver(env, db),
            modelRef: config.agents.routing.default.ref,
          }),
        }
      : {}),
  }
}

/**
 * Build the repo-sourced Claude Skills library's concrete ports when opted in
 * (ADR 0024). Skills live in ONE tier (the account), so the
 * installation resolver is account-only. Gated on the same `fragmentLibrary.enabled`
 * flag as the fragment library (both are the repo-sourced prompt library). Returns
 * `{}` when disabled, so `createCore` leaves the skill module unassembled.
 */
export function selectSkillLibraryDeps(
  _env: Env,
  config: AppConfig,
  db: D1Database,
): Partial<CoreDependencies> {
  if (!config.fragmentLibrary.enabled) return {}
  const resolvers = createTierInstallationResolvers({
    installations: new D1GitHubInstallationRepository({ db }),
    workspaces: new D1WorkspaceRepository({ db }),
  })
  return {
    accountSkillRepository: new D1AccountSkillRepository({ db }),
    skillSourceRepository: new D1SkillSourceRepository({ db }),
    resolveSkillInstallationId: resolvers.forAccount,
  }
}

/**
 * Build the foundational-services catalog's concrete ports (migration 0073,
 * backend/docs/adr/0031-foundational-services.md).
 *
 * Deliberately UNGATED, unlike the two libraries above: a service can be registered with its
 * contracts uploaded directly, so the catalog is useful on a deployment that wants neither
 * repo-sourced prompt fragments nor Claude skills. The feature is opt-in by CONTENT — a
 * deployment that registers nothing gets an empty catalog, and an empty catalog renders as the
 * "none are registered" line, which leaves every design prompt exactly as it was.
 *
 * It reuses the FRAGMENT installation resolver (`resolveFragmentInstallationId`), which already
 * answers for both tiers — the same pair this catalog is keyed by. `selectFragmentLibraryDeps`
 * sets the identical resolver when it is enabled; the two agree by construction because both
 * come from `createTierInstallationResolvers`.
 */
export function selectFoundationalServiceDeps(db: D1Database): Partial<CoreDependencies> {
  const resolvers = createTierInstallationResolvers({
    installations: new D1GitHubInstallationRepository({ db }),
    workspaces: new D1WorkspaceRepository({ db }),
  })
  return {
    foundationalServiceRepository: new D1FoundationalServiceRepository({ db }),
    apiContractRepository: new D1ApiContractRepository({ db }),
    foundationalServiceSourceRepository: new D1FoundationalServiceSourceRepository({ db }),
    resolveFragmentInstallationId: resolvers.forOwner,
  }
}

/**
 * The hosted PAT-login registry: lets a user sign in by pasting their OWN source-control PAT,
 * which the shared `/auth/pat` flow resolves to the account it belongs to (and holds to the
 * server's login/org/domain allowlist — see `AuthController`). GitHub is always available;
 * GitLab is added when a GitLab connection is configured. A remote deployment is multi-user, so
 * there is NO `configuredToken` — each user supplies their own PAT. Symmetric with the Node
 * facade's `buildNodeVcsIdentityRegistry` per "keep the runtimes symmetric": a GitLab-only Worker
 * deployment must let a GitLab user sign in, not just gate/merge on GitLab under the hood.
 */
export function buildWorkerVcsIdentityRegistry(config: AppConfig): VcsIdentityRegistry {
  const registry: VcsIdentityRegistry = {
    github: { resolver: new GitHubIdentityResolver({ apiBase: config.github.apiBase, logger }) },
  }
  if (config.gitlab?.enabled) {
    registry.gitlab = {
      resolver: new GitLabIdentityResolver({ apiBase: config.gitlab.apiBase, logger }),
    }
  }
  return registry
}

/**
 * The Worker facade's infrastructure capabilities, as the SPA's infrastructure selector reads
 * them: repo-operating agents run on per-run Cloudflare Containers (always available) and can
 * additionally delegate to a self-hosted runner pool when one is configured; tester environments
 * run via the environment provider. Extracted from {@link buildContainer} to keep that (budgeted)
 * function inside its per-function line ceiling — the budget is a split trigger, never a number
 * to raise.
 */
function workerInfrastructureCapabilities(
  config: AppConfig,
): ReturnType<typeof buildInfrastructureCapabilities> {
  return buildInfrastructureCapabilities({
    execution: {
      available: config.runners.enabled
        ? ['cloudflare-containers', 'runner-pool']
        : ['cloudflare-containers'],
      active: 'cloudflare-containers',
    },
    testEnv: { available: ['environment-provider'], active: 'environment-provider' },
    // The Worker only runs the self-contained UI-test container (torn down with the run); it
    // has no long-lived host serve, so a browsable frontend preview is unsupported here.
    frontendPreview: { supported: false },
    // The hosted Worker facade has account admins to govern the account-wide model policy.
    modelPolicy: { supported: true },
  })
}

export function buildContainer(
  env: Env,
  overrides: Partial<CoreDependencies> = {},
  opts: {
    cloudflareModelsEnabled?: boolean
    gateProviders?: GateProviderOverrides
  } = {},
): Container {
  const config = loadConfig(env)
  config.infrastructure = workerInfrastructureCapabilities(config)
  // The primary transactional store. Required: fail fast here with a fixable message rather than
  // NPE deep in the first repository call when the `DB` binding is unbound/misnamed.
  const db = requireDb(env)
  // Telemetry (llm_call_metrics + agent_context_snapshots) lives in its own D1 database
  // — append-heavy/high-volume/short-retention, unlike the transactional domain. The
  // binding is required: fail fast here rather than NPE deep in a repo on first write.
  const telemetryDb = requireTelemetryDb(env)
  const clock = new SystemClock()
  const idGenerator = new CryptoIdGenerator()

  // The app-owned cache bag, on the ISOLATE-SAFE profile: a Worker isolate has no
  // cross-isolate invalidation bus (and no Redis), so caches of mutable cross-instance
  // state (the fragment catalog / repo projection / account policy / account settings) are
  // configured pass-through rather than TTL'd — a stale-serving cache would be a correctness
  // bug, not an optimization (see @cat-factory/caching's README). Self-verifying caches (the
  // document body + the head-sha-probed `repoFiles` reads) stay enabled — safe to keep on
  // because the probe bounds their staleness even without a bus. Note the bag is rebuilt per
  // invocation (this runs per request / per Workflow wake), so on the Worker these caches
  // mainly dedupe reads WITHIN one wake (e.g. a post-op's batch); the cross-run refresh-window
  // probe is chiefly the Node (process-lived cache) path. Built once here and SHARED: threaded
  // into the GitHub repo-files resolver (slice 4), the account-settings service, AND the
  // account-policy read the capability resolver runs, AND handed to `createCore`.
  const caches = createAppCaches({ profile: ISOLATE_SAFE_APP_CACHES_PROFILE, operationalMetrics })

  // The app-owned backend registries (env + runner kind → provider, agent-kind, gate,
  // step-resolver, initiative-preset, VCS, gate-provider): the injected instance via `overrides`
  // (a deployment's custom backend by reference, or the conformance suite's pre-loaded one), else
  // the built-in default. The SAME instances are threaded into the executors / createCore / the
  // boot-time `validateRegistrationsOnce` / the ServerContainer snapshot projection. The GitLab
  // VCS provider + the gate providers are wired onto `vcsRegistry` / `providerRegistry` below when
  // configured (fresh-per-build, so no module-global reset is needed).
  const {
    environmentBackendRegistry,
    runnerBackendRegistry,
    customManifestTypeRegistry,
    userSecretKindRegistry,
    agentKindRegistry,
    gateRegistry,
    judgeRegistry,
    stepResolverRegistry,
    initiativePresetRegistry,
    vcsRegistry,
    providerRegistry,
  } = resolveWorkerRegistries(overrides)

  // Binary-artifact storage (UI screenshots + reference design images) for the
  // visual-confirmation gate. The backend is configured PER ACCOUNT in the UI: an account can
  // keep the deployment's R2 bucket (the default when the ARTIFACT_BUCKET binding is present)
  // or switch to its own S3 bucket. The metadata always lives in D1; only the bytes' backend
  // changes. The store is resolved per request/run from the account settings
  // (`resolveBinaryArtifactStore`, built below once `accountSettings` exists).
  const { capability: contentStorageCapability, buildBlobBackend: buildCfBlobBackend } =
    cloudflareContentStorage(env)

  // The built-in gates' providers are wired onto the app-owned `providerRegistry` (news'd above,
  // fresh per build unless injected via `overrides`). `selectMergeLifecycleDeps` /
  // `selectReleaseHealthDeps` / `selectIncidentEnrichmentDeps` wire theirs only inside their
  // `enabled` branches; a fresh registry starts empty, so an unconfigured gate simply stays
  // unwired (pass-through) — no reset needed (the former `clearGateProviders()` guarded a
  // module-global that no longer exists). Any test-injected gate providers (`opts.gateProviders`)
  // are applied at the END of this build (after the config wiring) so they OVERRIDE it, and — when
  // the test injects its own `providerRegistry` via `overrides` — survive the per-request rebuild.

  // Opt-in GitLab VCS provider (single-token model, mirroring local-mode's PAT). Registered on
  // the app-owned `vcsRegistry` above so the neutral webhook route + any VcsConnectionRef holder
  // resolves it. A no-op unless GITLAB_TOKEN is set; symmetric with the Node facade (local
  // inherits it) per "keep the runtimes symmetric".
  if (config.gitlab?.enabled && env.GITLAB_TOKEN) {
    registerGitLab(vcsRegistry, {
      tokenSource: new StaticGitLabTokenSource(env.GITLAB_TOKEN, config.gitlab.apiBase),
      clock,
      webhookSecret: config.gitlab.webhookSecret || undefined,
      logger,
    })
  }

  // The unified provisioning event log lives in a SEPARATE D1 database (its own
  // binding + migrations) to isolate its high write churn. When wired, build the
  // repo + a best-effort recorder shared by the env services (via createCore) and
  // the runner/container transport decorator below.
  const provisioningLogRepository = env.PROVISIONING_DB
    ? new D1ProvisioningLogRepository({ db: env.PROVISIONING_DB })
    : undefined
  const provisioningLogRecorder = provisioningLogRepository
    ? new ProvisioningLogRecorder({ repository: provisioningLogRepository, idGenerator, clock })
    : undefined

  // The runner-backend factory is shared by every container-backed flow (the
  // implementation executor and the repo bootstrapper), so both dispatch through the
  // same Cloudflare/self-hosted seam — and the bootstrapper rides the reaping-aware
  // Cloudflare transport for free. Null when no backend is configured.
  // `overrides.runnerPoolProvider` swaps the shared HTTP provider the built-in `manifest` pool
  // reuses (its OAuth cache); the `...overrides` spread (last, below) already routes it to the
  // connection-management UI, so thread it here too so it ALSO drives the manifest backend's
  // dispatch transport. (A bespoke runner backend is registered by reference into
  // `runnerBackendRegistry`, NOT this provider override.)
  const resolveTransport = buildResolveTransport({
    env,
    config,
    db,
    clock,
    provisioningLog: provisioningLogRecorder,
    runnerBackendRegistry,
    injectedPoolProvider: overrides.runnerPoolProvider,
  })

  // The deployment-wide stores and sinks every controller and the engine share: the credential
  // pools, the per-run telemetry sinks, the account-settings reader and the derived
  // artifact-store / web-search / webhook seams. Extracted so this root stays within the
  // per-function line budget; every field is consumed by `assembleWorkerContainer`, so it is
  // SPREAD there rather than re-listed.
  const shared = buildWorkerSharedServices({
    env,
    config,
    db,
    telemetryDb,
    clock,
    idGenerator,
    caches,
    userSecretKindRegistry,
    contentStorageCapability,
    buildCfBlobBackend,
    cloudflareModelsEnabledOverride: opts.cloudflareModelsEnabled,
  })

  // How a registered capability's declared credentials are resolved at dispatch, composed ONCE
  // here so the dispatch path and the credential CHECKLIST read one composition: whether an
  // unstored key still resolves from the deployment's own vars is a property of what was composed,
  // and the checklist has to describe it rather than assert a default beside it.
  //
  // The policy is read from the PROCESS-WIDE registration rather than from `opts`, because this
  // function has many callers and only one of them is the request path: the durable driver
  // (`ExecutionWorkflow`), the queue consumers and every cron sweeper each build their own
  // container from a bare `buildContainer(env)`. Container agents are dispatched by the durable
  // driver, so an option carried on `createApp` alone would be accepted and then never asked
  // anything. A deployment's own resolver (built from THIS entry point's `env`: a Worker binding,
  // D1 or a Secrets Store, is only reachable that way) REPLACES the chain; absent, the platform's
  // per-workspace store answers first and the Worker's configured vars answer behind it.
  const toolSecretChain = buildToolSecretChain({
    custom: resolveRegisteredToolSecretResolver(env),
    credentials: shared.capabilityCredentialsService,
    env: env as unknown as Record<string, unknown>,
    environmentFallback: registeredToolSecretEnvironmentFallback(),
    logger,
  })

  return assembleWorkerContainer({
    ...shared,
    env,
    config,
    db,
    telemetryDb,
    clock,
    idGenerator,
    caches,
    overrides,
    gateProviders: opts.gateProviders,
    // The composed capability-credential chain (above): the resolver the container executor asks,
    // and the description the credential checklist renders.
    toolSecretChain,
    registries: {
      environmentBackendRegistry,
      runnerBackendRegistry,
      customManifestTypeRegistry,
      userSecretKindRegistry,
      agentKindRegistry,
      gateRegistry,
      judgeRegistry,
      stepResolverRegistry,
      initiativePresetRegistry,
      vcsRegistry,
      providerRegistry,
    },
    provisioningLogRepository,
    resolveTransport,
  })
}
