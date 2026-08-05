// The container dispatchers the Worker composition root wires BESIDE the step executor: the repo
// bootstrapper and the env-config repairer.
//
// They sit together because they are one concern rather than two. Each hands a container a real
// clone/push credential, which is what `backend/docs/security-model.md` Layer 3 bounds, and each
// mints it through `workerDispatchTokenMint` so the token names only the repo that dispatch
// touches. The mint itself stays in the composition root because the deploy clone target uses it
// too; this module is the pair that would otherwise keep the root over its size budget.
//
// NOT here: the step executor's own mint, which lives in `container-executor-deps.ts` beside the
// run-initiator PAT chain it composes in front of the App token.

import {
  ContainerEnvConfigRepairer,
  ContainerRepoBootstrapper,
  ContainerSessionService,
  FetchGitHubClient,
  type AppConfig,
  type ResolveRunnerTransport,
  logger,
  resolveUrlSafetyPolicy,
} from '@cat-factory/server'
import type { Clock, IdGenerator } from '@cat-factory/kernel'
import type { CoreDependencies } from '@cat-factory/orchestration'
import type { EnvironmentBackendRegistry } from '@cat-factory/integrations'
import { isProxyableProvider, resolveAgentConfig } from '@cat-factory/agents'
import type { Env } from './env'
import {
  buildAppRegistry,
  buildResolvePackageRegistries,
  workerDispatchTokenMint,
} from './container'
import { D1BootstrapJobRepository } from './repositories/D1BootstrapJobRepository'
import { D1GitHubInstallationRepository } from './repositories/D1GitHubInstallationRepository'
import { D1RateLimitRepository } from './repositories/D1RateLimitRepository'
import { D1RepoProjectionRepository } from './repositories/D1RepoProjectionRepository'

/**
 * Build the container-backed repo bootstrapper for the "bootstrap repo" task,
 * gated on the same prerequisites as the implementation container (the binding, a
 * configured GitHub App, the proxy's public URL and signing secret). Returns
 * undefined otherwise, leaving reference-architecture CRUD available while the run
 * path reports itself unavailable.
 */
export function selectRepoBootstrapper(
  env: Env,
  config: AppConfig,
  db: D1Database,
  clock: Clock,
  idGenerator: IdGenerator,
  resolveTransport: ResolveRunnerTransport | null,
): ContainerRepoBootstrapper | undefined {
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
    // Narrowed to the one repo being scaffolded (see the shared builder).
    mintInstallationToken: workerDispatchTokenMint(registry),
    sessionService: new ContainerSessionService({ secret: env.AUTH_SESSION_SECRET }),
    // Bootstrap is an `architect`-kind run, so it follows that kind's routing
    // (GLM-5.2 by default) rather than the global default.
    model: resolveAgentConfig(config.agents.routing, 'architect').ref,
    proxyBaseUrl: `${env.WORKER_PUBLIC_URL.replace(/\/+$/, '')}/v1`,
    githubApiBase: config.github.apiBase,
    ...(resolvePackageRegistries ? { resolvePackageRegistries } : {}),
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
