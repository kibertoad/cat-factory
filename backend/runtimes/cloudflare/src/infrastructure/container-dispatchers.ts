// The container dispatchers the Worker composition root wires BESIDE the step executor: the repo
// bootstrapper, the env-config repairer and the environment dry-run prober.
//
// They sit together because they are one concern rather than two. Each hands a container a real
// clone/push credential, which is what `backend/docs/security-model.md` Layer 3 bounds, and each
// mints it through `workerDispatchTokenMint` so the token names only the repo that dispatch
// touches. The mint itself lives in its own leaf (`dispatchTokenMint.ts`) because the deploy
// clone target uses it too; this module is the pair that would otherwise keep the composition
// root over its size budget.
//
// NOT here: the step executor's own mint, which lives in `container-executor-deps.ts` beside the
// run-initiator PAT chain it composes in front of the App token.

import {
  ContainerEnvConfigRepairer,
  ContainerEnvironmentProbeAgent,
  ContainerJobAuthResolver,
  ContainerRepoBootstrapper,
  ContainerSessionService,
  FetchGitHubClient,
  buildSingleKindModelResolver,
  deploymentRepoOrigin,
  type AppConfig,
  type ContainerJobAuthDependencies,
  type ResolveRunnerTransport,
  logger,
  resolveUrlSafetyPolicy,
} from '@cat-factory/server'
import type {
  AgentContextRecorder,
  AppCaches,
  Clock,
  IdGenerator,
  SubscriptionVendor,
} from '@cat-factory/kernel'
import type { CoreDependencies } from '@cat-factory/orchestration'
import type {
  EnvironmentBackendRegistry,
  PersonalSubscriptionService,
  ProviderSubscriptionService,
} from '@cat-factory/integrations'
import { isProxyableProvider, resolveAgentConfig } from '@cat-factory/agents'
import type { Env } from './env'
import { buildAppRegistry, buildResolvePackageRegistries } from './container'
import {
  buildResolvePresetProviderPreference,
  buildResolveWorkspaceModelDefault,
} from './container-model-resolver'
import { workerDispatchTokenMint } from './dispatchTokenMint'
import { buildToolTrajectorySinks } from './container-executor-deps'
import { D1BlockRepository } from './repositories/D1BlockRepository'
import { D1BootstrapJobRepository } from './repositories/D1BootstrapJobRepository'
import { D1GitHubInstallationRepository } from './repositories/D1GitHubInstallationRepository'
import { D1RateLimitRepository } from './repositories/D1RateLimitRepository'
import { D1RepoProjectionRepository } from './repositories/D1RepoProjectionRepository'
import { buildTestSecretsService } from './wireCredentialServices'

/**
 * Build the container-backed repo bootstrapper for the "bootstrap repo" task,
 * gated on the same prerequisites as the implementation container (the binding, a
 * configured GitHub App, the proxy's public URL and signing secret). Returns
 * undefined otherwise, leaving reference-architecture CRUD available while the run
 * path reports itself unavailable.
 */
export function selectRepoBootstrapper(deps: {
  env: Env
  config: AppConfig
  db: D1Database
  clock: Clock
  idGenerator: IdGenerator
  resolveTransport: ResolveRunnerTransport | null
  /**
   * The provided-context sink, shared with the container executor. Absent ⇒ a bootstrap files
   * no snapshot, exactly as an execution step would not: the capability is the deployment's,
   * never the run kind's.
   */
  agentContextObservability?: AgentContextRecorder
}): ContainerRepoBootstrapper | undefined {
  const { env, config, db, clock, idGenerator, resolveTransport, agentContextObservability } = deps
  if (
    !resolveTransport ||
    !config.github.enabled ||
    !env.GITHUB_APP_PRIVATE_KEY ||
    !env.WORKER_PUBLIC_URL ||
    !env.AUTH_SESSION_SECRET
  ) {
    return undefined
  }

  const installationRepository = new D1GitHubInstallationRepository({ db })
  const registry = buildAppRegistry(env, config, db, clock)
  const githubClient = new FetchGitHubClient({
    registry,
    rateLimitRepository: new D1RateLimitRepository({ db, idGenerator }),
    idGenerator,
    clock,
    apiBase: config.github.apiBase,
  })

  // The scaffolder installs dependencies too — forward the workspace's
  // private-registry entries exactly as the implementation executor does.
  const resolvePackageRegistries = buildResolvePackageRegistries(env, db)

  return new ContainerRepoBootstrapper({
    resolveTransport,
    installationRepository,
    bootstrapJobRepository: new D1BootstrapJobRepository({ db }),
    repoRepository: new D1RepoProjectionRepository({ db }),
    githubClient,
    // The client above is the GitHub App's, and this whole builder is gated on the App being
    // configured, so the provider it speaks is not in doubt. Stated anyway: it is what refuses a
    // workspace connected to another provider instead of probing it with the wrong credential.
    clientProvider: 'github',
    // Narrowed to the one repo being scaffolded (see the shared builder).
    mintInstallationToken: workerDispatchTokenMint(registry),
    sessionService: new ContainerSessionService({ secret: env.AUTH_SESSION_SECRET }),
    // Bootstrap is an `architect`-kind run, so it follows that kind's routing
    // (GLM-5.2 by default) rather than the global default.
    model: resolveAgentConfig(config.agents.routing, 'architect').ref,
    proxyBaseUrl: `${env.WORKER_PUBLIC_URL.replace(/\/+$/, '')}/v1`,
    githubApiBase: config.github.apiBase,
    ...(resolvePackageRegistries ? { resolvePackageRegistries } : {}),
    // A bootstrap run is inspected through the same panel as any other agent run, so it
    // records through the same sinks: the provided-context snapshot per dispatch, and the
    // tool-call trajectory (plus trace spans) drained on every poll.
    ...(agentContextObservability ? { agentContextObservability } : {}),
    ...buildToolTrajectorySinks({ env, config, db, clock }),
  })
}

/**
 * Build the live ENVIRONMENT-PROVIDER CONFIG REPAIR agent (PR #416 increment 2) when its
 * prerequisites are met — the same container prerequisites as the bootstrapper PLUS an
 * injected provider that actually supports agent repair (`describeRepairAgent`). A stock
 * deployment runs the generic manifest provider (no repair support), so this stays
 * undefined there; it wires only when a native adapter is injected. Built
 * over the FINAL provider (post-overrides), so the dispatcher repairs through the same
 * provider the engine validates with. NOT to be confused with the repo bootstrapper: this
 * is an ordinary clone→edit→push coding job (no history reset / force-push).
 */
export function selectEnvConfigRepairer(deps: {
  env: Env
  config: AppConfig
  db: D1Database
  clock: Clock
  resolveTransport: ResolveRunnerTransport | null
  override: CoreDependencies['environmentProvider']
  environmentBackendRegistry: EnvironmentBackendRegistry
}): ContainerEnvConfigRepairer | undefined {
  const { env, config, db, clock, resolveTransport, override, environmentBackendRegistry } = deps
  const repairUrlPolicy = resolveUrlSafetyPolicy(config.environments)
  // Prefer the internal override (the conformance suite's fake repair provider) else scan
  // the env-backend registry for the first repair-capable backend.
  const environmentProvider = !resolveTransport
    ? undefined
    : (override ??
      environmentBackendRegistry.findRepairCapable(
        repairUrlPolicy ? { urlPolicy: repairUrlPolicy } : {},
      ))
  if (
    !resolveTransport ||
    !environmentProvider ||
    typeof environmentProvider.describeRepairAgent !== 'function' ||
    !config.github.enabled ||
    !env.GITHUB_APP_PRIVATE_KEY ||
    !env.WORKER_PUBLIC_URL ||
    !env.AUTH_SESSION_SECRET
  ) {
    return undefined
  }
  // A config fix is coding work, so it follows the `coder` kind's routing. The repair runs on
  // the Pi harness over the LLM proxy, so the routed model MUST be proxyable. Surface a
  // misconfiguration HERE (at wiring) rather than letting every repair dispatch throw deep in a
  // request: if `coder` is routed to a non-proxyable model (e.g. an individual subscription
  // vendor), leave the fallback unwired — bootstrap then returns the validation issues, exactly
  // as it does when no provider supports repair.
  const model = resolveAgentConfig(config.agents.routing, 'coder').ref
  if (!isProxyableProvider(model.provider)) {
    logger.warn(
      'env-config repair: the coder routing model is not proxyable by the LLM proxy; ' +
        'the agent config-repair fallback is disabled.',
      { provider: model.provider },
    )
    return undefined
  }
  const registry = buildAppRegistry(env, config, db, clock)
  return new ContainerEnvConfigRepairer({
    resolveTransport,
    installationRepository: new D1GitHubInstallationRepository({ db }),
    repoRepository: new D1RepoProjectionRepository({ db }),
    // Narrowed to the one repo the agent edits (see the shared builder).
    mintInstallationToken: workerDispatchTokenMint(registry),
    sessionService: new ContainerSessionService({ secret: env.AUTH_SESSION_SECRET }),
    environmentProvider,
    model,
    proxyBaseUrl: `${env.WORKER_PUBLIC_URL.replace(/\/+$/, '')}/v1`,
    githubApiBase: config.github.apiBase,
  })
}

/**
 * Build the environment AGENT DRY RUN prober, gated on the same container prerequisites as the
 * bootstrapper: a runner transport, a configured source-control App, the proxy's public URL and
 * its signing secret. Absent any of them the self-test still runs in `provision` mode and
 * `startTest` refuses `agent-probe` with a 409 that names the gap.
 *
 * The MODEL is not one of those prerequisites, and treating it as one is what this wiring got
 * wrong: it read the TESTERS' env routing here and pinned the prober to it for the deployment's
 * lifetime. A model is a per-WORKSPACE fact, resolved per dispatch from the frame's own pin, else
 * the workspace's model preset for the prober's kind (`environment-prober-api` / `-ui`), else the
 * env routing: the precedence every pipeline step already gets. So a workspace on its Claude
 * preset gets a Claude dry run, and its subscription is leased rather than refused: the auth deps
 * below are the same ones the step executor uses, which is what makes a subscription harness
 * runnable here at all. Mirror of the Node family's `selectNodeEnvironmentProbeAgent`.
 */
export function selectEnvironmentProbeAgent(deps: {
  env: Env
  config: AppConfig
  db: D1Database
  clock: Clock
  caches?: AppCaches
  resolveTransport: ResolveRunnerTransport | null
  subscriptions?: ProviderSubscriptionService
  personalSubscriptions?: PersonalSubscriptionService
}): ContainerEnvironmentProbeAgent | undefined {
  const { env, config, db, clock, resolveTransport } = deps
  if (
    !resolveTransport ||
    !config.github.enabled ||
    !env.GITHUB_APP_PRIVATE_KEY ||
    !env.WORKER_PUBLIC_URL ||
    !env.AUTH_SESSION_SECRET
  ) {
    return undefined
  }
  const registry = buildAppRegistry(env, config, db, clock)
  // The frame's sealed test credentials, resolved through the same service the tester dispatch
  // uses. Absent (no ENCRYPTION_KEY) ⇒ the prober is told there are none, which is what puts the
  // gap in its report rather than in its guesswork.
  const testSecrets = buildTestSecretsService(env, db, clock)
  // Every credential channel a container dispatch can carry: the model-locked proxy session token
  // for a Pi model, the pooled lease for Claude Code / Codex, the initiator's own personal lease
  // for an individual-usage vendor. One composition, shared with the routing predicates below, so
  // the vendor the model resolves ON is the vendor the credential is leased FOR.
  const authDeps: ContainerJobAuthDependencies & {
    hasSubscriptionToken?: (workspaceId: string, vendor: SubscriptionVendor) => Promise<boolean>
    hasPersonalSubscription?: (userId: string, vendor: SubscriptionVendor) => Promise<boolean>
  } = {
    sessionService: new ContainerSessionService({ secret: env.AUTH_SESSION_SECRET }),
    proxyBaseUrl: `${env.WORKER_PUBLIC_URL.replace(/\/+$/, '')}/v1`,
    ...(deps.subscriptions
      ? {
          leaseSubscriptionToken: (workspaceId: string, vendor: SubscriptionVendor) =>
            deps.subscriptions!.leaseToken(workspaceId, vendor),
          hasSubscriptionToken: (workspaceId: string, vendor: SubscriptionVendor) =>
            deps.subscriptions!.hasToken(workspaceId, vendor),
        }
      : {}),
    ...(deps.personalSubscriptions
      ? {
          leasePersonalSubscriptionToken: (
            executionId: string,
            userId: string,
            vendor: SubscriptionVendor,
          ) => deps.personalSubscriptions!.leaseForRun(executionId, userId, vendor),
          hasPersonalSubscription: (userId: string, vendor: SubscriptionVendor) =>
            deps.personalSubscriptions!.has(userId, vendor),
        }
      : {}),
    // No `nativeAmbientAuth`: the ambient-CLI path is the LOCAL facade's, and a Worker has no host
    // process with a developer's login on it.
  }
  return new ContainerEnvironmentProbeAgent({
    resolveTransport,
    installationRepository: new D1GitHubInstallationRepository({ db }),
    repoRepository: new D1RepoProjectionRepository({ db }),
    mintInstallationToken: workerDispatchTokenMint(registry),
    resolveModel: buildSingleKindModelResolver({
      agentRouting: config.agents.routing,
      resolveBlockModel: config.agents.resolveBlockModel,
      blockRepository: new D1BlockRepository({ db }),
      resolveWorkspaceModelDefault: buildResolveWorkspaceModelDefault(db, deps.caches),
      resolvePresetProviderPreference: buildResolvePresetProviderPreference(db, deps.caches),
      ...(authDeps.hasSubscriptionToken
        ? { hasSubscriptionToken: authDeps.hasSubscriptionToken }
        : {}),
      ...(authDeps.hasPersonalSubscription
        ? { hasPersonalSubscription: authDeps.hasPersonalSubscription }
        : {}),
    }),
    auth: new ContainerJobAuthResolver(authDeps),
    // Provider-aware, so a GitLab deployment's prober clones its own instance rather than a
    // same-named project on github.com.
    resolveRepoOrigin: deploymentRepoOrigin(config),
    ...(testSecrets
      ? {
          resolveTestSecrets: (workspaceId: string, blockId: string) =>
            testSecrets.resolveValuesForBlock(workspaceId, blockId),
        }
      : {}),
    githubApiBase: config.github.apiBase,
  })
}
