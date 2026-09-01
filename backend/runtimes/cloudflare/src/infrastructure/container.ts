import {
  type Clock,
  type EmailSender,
  type ExecutionEventPublisher,
  type IdGenerator,
  type NotificationChannel,
  NoopWorkRunner,
  type VcsIdentityRegistry,
  type WorkRunner,
  type ProviderRegistry,
} from '@cat-factory/kernel'
import {
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
import { buildAppRegistry, buildResolveRepoTarget } from './container-vcs-identity.js'
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
import { workerAppCaches } from './appCachesHost'
import {
  FanOutEventPublisher,
  buildToolSecretChain,
  logger,
  buildInfrastructureCapabilities,
  GitHubIdentityResolver,
  resolveUrlSafetyPolicy,
  type JobPackageRegistrySpec,
  type ServerContainer,
} from '@cat-factory/server'
import { type AppConfig, loadConfig } from './config'
import type { Env } from './env'
import { envBag, requireDb, requireTelemetryDb } from './env'
import { HttpRunnerPoolProvider } from './runners/HttpRunnerPoolProvider'
import { D1RunnerPoolConnectionRepository } from './repositories/D1RunnerPoolConnectionRepository'
import { DurableObjectEventPublisher } from './events/DurableObjectEventPublisher'
import { WorkflowsWorkRunner } from './workflows/WorkflowsWorkRunner'
import { D1BlockRepository } from './repositories/D1BlockRepository'
import { D1WorkspaceMountRepository } from './repositories/D1WorkspaceMountRepository'
import { D1ProvisioningLogRepository } from './repositories/D1ProvisioningLogRepository'
import { D1AccountInvitationRepository } from './repositories/D1AccountInvitationRepository'
import { D1PasswordResetTokenRepository } from './repositories/D1PasswordResetTokenRepository'
import { D1EmailConnectionRepository } from './repositories/D1EmailConnectionRepository'
import { D1EnvironmentConnectionRepository } from './repositories/D1EnvironmentConnectionRepository'
import { D1CustomManifestTypeRepository } from './repositories/D1CustomManifestTypeRepository'
import { D1EnvironmentRegistryRepository } from './repositories/D1EnvironmentRegistryRepository'
import { D1RequirementReviewRepository } from './repositories/D1RequirementReviewRepository'
import { D1DocInterviewRepository } from './repositories/D1DocInterviewRepository'
import { D1KaizenGradingRepository } from './repositories/D1KaizenGradingRepository'
import { D1KaizenVerifiedComboRepository } from './repositories/D1KaizenVerifiedComboRepository'
import { D1ClarityReviewRepository } from './repositories/D1ClarityReviewRepository'
import { D1BrainstormSessionRepository } from './repositories/D1BrainstormSessionRepository'
import { D1NotificationRepository } from './repositories/D1NotificationRepository'
import { D1InitiativeRepository } from './repositories/D1InitiativeRepository'
import { D1MergeTrackRecordRepository } from './repositories/D1MergeTrackRecordRepository'
import { D1RiskPolicyRepository } from './repositories/D1RiskPolicyRepository'
import {
  D1AccountRiskPolicyRepository,
  D1RiskPolicySuppressionRepository,
} from './repositories/D1AccountRiskPolicyRepository'
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
import { selectWorkspaceConfigDeps } from './container-workspace-config-deps'
import { D1ObservabilityConnectionRepository } from './repositories/D1ObservabilityConnectionRepository'
import { D1PackageRegistryConnectionRepository } from './repositories/D1PackageRegistryConnectionRepository'

import { D1IncidentEnrichmentConnectionRepository } from './repositories/D1IncidentEnrichmentConnectionRepository'
import { D1ReleaseHealthConfigRepository } from './repositories/D1ReleaseHealthConfigRepository'
// The built-in polling-gate suite (ci / conflicts / post-release-health + on-call). The facade
// builds an app-owned `GateRegistry` pre-loaded with the suite via `gateRegistryWithBuiltins()`,
// then wires each gate's provider below.
import {
  type GateProviderOverrides,
  wireReleaseHealthProvider,
  wireIncidentEnrichment,
} from '@cat-factory/gates'
import {
  GitLabIdentityResolver,
  registerGitLab,
  StaticGitLabTokenSource,
} from '@cat-factory/gitlab'
import { wireEngineVcsDeps } from './container-engine-vcs-deps'
import { WebCryptoSecretCipher } from './environments/WebCryptoSecretCipher'
import {} from './repositories/D1FoundationalServiceRepository'
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

/**
 * Build the merge-lifecycle ports. The notification repository + merge-preset repository are
 * wired unconditionally (the inbox + presets are always available); the in-app delivery channel
 * is wired only when the events binding is present (else rows persist but nothing is pushed).
 * The VCS-backed halves need a source-control client, so they come from `wireEngineVcsDeps` and
 * are absent when neither the App nor a GitLab token is configured.
 */
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
    // The ACCOUNT tier of that library + each board's suppressions of it (ADR 0055), wired beside
    // the board tier so the merge behaves identically on both runtimes.
    accountRiskPolicyRepository: new D1AccountRiskPolicyRepository({ db }),
    riskPolicySuppressionRepository: new D1RiskPolicySuppressionRepository({ db }),
    mergeTrackRecordRepository: new D1MergeTrackRecordRepository({ db }),
    // Shared stacks (long-lived compose infra a consumer environment attaches to). CRUD +
    // persistence are runtime-symmetric; the Worker never brings a stack UP (no host daemon),
    // so no `composeRuntime` is wired here — the lifecycle endpoints report "not supported".
    sharedStackRepository: new D1SharedStackRepository({ db }),
    workspaceSettingsRepository: new D1WorkspaceSettingsRepository({ db }),
    ...selectPerUserDeps(db),
    ...selectWorkspaceConfigDeps(db),
    initiativeRepository: new D1InitiativeRepository({ db }),
  }
  // How this deployment tells a human, composed whole in `container-notification-deps.ts`: the
  // routed in-app push, the external transports, and the manager's store the settings API writes.
  Object.assign(
    deps,
    selectNotificationDeliveryDeps({
      config,
      db,
      clock,
      publisher: selectEventPublisher(env, db),
      webhookChannel,
    }),
  )

  // The engine's VCS-backed halves: the client every gate / merge / review path reads through,
  // and the providers + publishers built over it. Its own module (`container-engine-vcs-deps.ts`),
  // the Worker's counterpart to Node's `container-github-deps.ts`. Neither provider configured
  // means an empty slice: the gates pass through and `done` is a board-only flip.
  Object.assign(deps, wireEngineVcsDeps({ env, config, db, clock, idGenerator, providerRegistry }))
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
      logger,
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
import { selectNotificationDeliveryDeps } from './container-notification-deps'

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

// The three CONTENT-LIBRARY selectors live in `container-content-library-deps.ts` (the twin of
// the Node facade's file of the same name). Re-exported here because `container-assembly.ts` and
// the extension-surface tests import them from this module.
export {
  selectFoundationalServiceDeps,
  selectFragmentLibraryDeps,
  selectSkillLibraryDeps,
} from './container-content-library-deps'

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
  if (config.gitlab.enabled) {
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

  // The app-owned cache bag, ONE per ISOLATE (appCachesHost.ts) rather than per invocation,
  // so a warm isolate keeps entries across requests. Which profile it runs is the coherency
  // opt-in: with the CACHE_GENERATIONS Durable Object bound, caches the coherent profile
  // names get a real TTL with a generation probe bounding cross-isolate staleness; without
  // it, the isolate-safe stance: caches of mutable cross-instance state pass through,
  // because a TTL with no invalidation reaching it would serve stale, a correctness bug
  // rather than an optimization (see @cat-factory/caching's README). Self-verifying caches
  // (the document body + the head-sha-probed `repoFiles` reads) are enabled on both
  // profiles: their probe bounds staleness without any bus. The bag is SHARED: threaded
  // into the GitHub repo-files resolver (slice 4), the account-settings service, AND the
  // account-policy read the capability resolver runs, AND handed to `createCore`.
  const caches = workerAppCaches(env)

  // The app-owned backend registries (env + runner kind → provider, agent-kind, gate,
  // step-resolver, initiative-preset, VCS, gate-provider): the injected instance via `overrides`
  // (a deployment's custom backend by reference, or the conformance suite's pre-loaded one), else
  // the built-in default. The SAME instances are threaded into the executors / createCore / the
  // boot-time `validateRegistrationsOnce` / the ServerContainer snapshot projection. The GitLab
  // VCS provider + the gate providers are wired onto `vcsRegistry` / `providerRegistry` below when
  // configured (fresh-per-build, so no module-global reset is needed).
  //
  // Kept as the resolved BUNDLE and forwarded whole, with only the three this function body wires
  // named individually. Re-listing all twelve on the way out is the one shape that can silently be
  // short by one, which is how a registry reaches the assembly on Node and misses it here.
  const registries = resolveWorkerRegistries(overrides)
  const { runnerBackendRegistry, userSecretKindRegistry, vcsRegistry } = registries

  // Binary-artifact storage (UI screenshots + reference design images) for the
  // visual-confirmation gate. The backend is configured PER ACCOUNT in the UI: an account can
  // keep the deployment's R2 bucket (the default when the ARTIFACT_BUCKET binding is present)
  // or switch to its own S3 bucket. The metadata always lives in D1; only the bytes' backend
  // changes. The store is resolved per request/run from the account settings
  // (`resolveBinaryArtifactStore`, built below once `accountSettings` exists).
  const { capability: contentStorageCapability, buildBlobBackend: buildCfBlobBackend } =
    cloudflareContentStorage(env, registries.binaryStoreRegistry)

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
  if (config.gitlab.enabled && env.GITLAB_TOKEN) {
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
    binaryStoreRegistry: registries.binaryStoreRegistry,
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
    env: envBag(env),
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
    registries,
    provisioningLogRepository,
    resolveTransport,
  })
}
