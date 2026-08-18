import { defaultAgentKindRegistry, defaultInitiativePresetRegistry } from '@cat-factory/agents'
// Opt-in AWS EKS backends (runner + environment), registered by reference below (the Worker
// facade registers the same pair, keeping the runtimes symmetric with the native `kubernetes`
// backend these extend). They are pass-throughs until a workspace actually connects an `eks`
// backend, and carry NO runtime AWS SDK dependency (the token is minted with WebCrypto), so this
// adds no cost to a deployment that never uses EKS.
import { eksEnvironmentBackend, eksRunnerBackend } from '@cat-factory/eks'
import { createBackendRegistries } from '@cat-factory/integrations'
import { type GitHubClient, defaultProviderRegistry, defaultVcsRegistry } from '@cat-factory/kernel'
import {
  defaultJudgeRegistry,
  defaultStepResolverRegistry,
  resolvePresetModelForKind,
  resolvePresetProviderPreference,
} from '@cat-factory/orchestration'
import { buildInfrastructureCapabilities, deploymentRepoOrigin, logger } from '@cat-factory/server'
// The built-in polling-gate suite (ci / conflicts / post-release-health + on-call). The facade
// builds an app-owned `GateRegistry` pre-loaded with the suite via `gateRegistryWithBuiltins()`
// below, then wires each gate's provider.
import { gateRegistryWithBuiltins } from '@cat-factory/gates'
import {
  buildGitLabEngineClient,
  registerGitLab,
  StaticGitLabTokenSource,
} from '@cat-factory/gitlab'
import { loadNodeConfig } from './config.js'
import type { DrizzleDb } from './db/client.js'
import { createDrizzleRepositories } from './repositories/drizzle.js'
import { CryptoIdGenerator, SystemClock } from './runtime.js'
// The container-agent-executor wiring (transport resolver, provisioning-log wrapper, container
// executor + bootstrapper + env-config repairer, GitHub-issue filer, trace-sink builder), lifted
// into a sibling module so this composition root stays within the file-size budget.

import type { NodeContainerOptions } from './container.js'

/**
 * The Node composition root's FOUNDATION: everything {@link buildNodeContainer} resolves before it
 * starts wiring modules — the effective env/config (with the Node infrastructure descriptor filled
 * in), the clock + id generator, the repository set plus the mothership-aware `sourced` picker, the
 * app-owned registries, the opt-in GitLab engine client, and the workspace model-preset resolver.
 * Carved out of `container.ts` for the per-function line budget
 * (docs/initiatives/lint-complexity-size-ratchet.md); the ordering of every side effect is
 * preserved exactly, so this is behaviour-neutral.
 */
/**
 * Source one org/durable repository that a standard build constructs directly from the Drizzle
 * `db`. In mothership mode (no Postgres) `remote` is the full-surface remote registry — a
 * `Proxy` (`createRemoteRepositoryRegistry`) that forwards any repo name to the hosted
 * mothership over the `/internal/persistence` RPC — so the repo comes from THERE instead of the
 * absent db; otherwise `build()` constructs the Drizzle repo over `db` as before. This is the
 * Phase-3 `db: undefined` audit seam: every direct-db store on the board-load + run path routes
 * through it. Routing is orthogonal to the server-side allow-list — an un-allow-listed remote
 * method still returns a clean `unknown_method`, never a `db`-undefined `TypeError`. Mirrors the
 * credential-repo override seam (`providerApiKeyRepository`), which keeps credentials local while
 * org state goes remote. See docs/initiatives/mothership-mode.md (Phase 3, part 1).
 */
export function pickRepoSource<T>(
  remote: Record<string, unknown> | undefined,
  name: string,
  build: () => T,
): T {
  return remote ? (remote[name] as T) : build()
}

/**
 * Resolve every app-owned registry the container wires: the backend-kind registries (env + runner
 * + custom-manifest + user-secret), the agent-kind / gate / step-resolver / initiative-preset /
 * VCS-provider / gate-provider registries. Each is the injected instance when `options` supplies it
 * (a deployment's custom entries, or the conformance harness's pre-loaded instance) else the
 * built-ins-only default, and the opt-in AWS EKS backends are registered by reference. Extracted
 * from {@link buildNodeContainer} to keep it under the complexity ceiling.
 */
function resolveNodeAppRegistries(options: NodeContainerOptions) {
  const {
    environmentBackendRegistry,
    runnerBackendRegistry,
    customManifestTypeRegistry,
    userSecretKindRegistry,
  } = options.backendRegistries ?? createBackendRegistries()

  // Register the opt-in AWS EKS backends by reference (the default registries stay AWS-free).
  // Reuses the native Kubernetes transport/provider behind a minted IAM apiserver token; a
  // pass-through until a workspace connects an `eks` backend. Registered on BOTH facades (the
  // Worker registers the same pair in its container build) so the runtimes stay symmetric with
  // the native `kubernetes` backend these extend — a real EKS cluster's private-CA apiserver is
  // only reachable from a runtime that can pin a custom CA (Node/local), the same constraint a
  // private-CA `kubernetes` connection already carries.
  runnerBackendRegistry.register(eksRunnerBackend)
  environmentBackendRegistry.register(eksEnvironmentBackend)

  return {
    environmentBackendRegistry,
    runnerBackendRegistry,
    customManifestTypeRegistry,
    userSecretKindRegistry,
    // The app-owned agent-kind registry: the injected instance (so a deployment's custom kinds
    // are visible) else the built-ins-only default.
    agentKindRegistry: options.agentKindRegistry ?? defaultAgentKindRegistry(),
    // The app-owned gate registry: the injected instance (conformance / a deployment pre-loads it),
    // else a fresh one with the built-in `@cat-factory/gates` suite installed.
    gateRegistry: options.gateRegistry ?? gateRegistryWithBuiltins(),
    // The app-owned step-resolver registry: the injected instance else an empty default (the
    // built-in `merger` resolver is a privileged engine built-in, not a registry entry).
    stepResolverRegistry: options.stepResolverRegistry ?? defaultStepResolverRegistry(),
    // The app-owned JUDGE registry (the fourth step-taxonomy bucket): the injected instance
    // (conformance / a deployment pre-loads it) else an empty default — the platform ships no
    // built-in judges. See `docs/initiatives/judge-registry.md`.
    judgeRegistry: options.judgeRegistry ?? defaultJudgeRegistry(),
    // The app-owned initiative-preset registry: the injected instance else the built-ins-only
    // default (generic / docs-refresh / tech-migration).
    initiativePresetRegistry: options.initiativePresetRegistry ?? defaultInitiativePresetRegistry(),
    // Opt-in GitLab VCS provider registry (a no-op unless GITLAB_TOKEN is set; the wiring lives in
    // the caller, symmetric with the Worker facade per "keep the runtimes symmetric").
    vcsRegistry: options.vcsRegistry ?? defaultVcsRegistry(),
    // The app-owned provider registry the built-in gates probe through (fresh empty unless injected).
    providerRegistry: options.providerRegistry ?? defaultProviderRegistry(),
  }
}

/**
 * Resolve the composition root's foundation (see the module doc). Called FIRST by
 * {@link buildNodeContainer}, so its side effects — filling `config.infrastructure` and
 * registering the GitLab VCS provider — happen in the same order as when this was inline.
 */
export function resolveNodeContainerFoundation(options: NodeContainerOptions) {
  const env = options.env ?? process.env
  const config = options.config ?? loadNodeConfig(env)
  // A browsable preview needs a per-runtime host-port-publish transport. Plain Node (runner
  // pool) has none, so advertise support ONLY when a `previewTransport` is actually wired
  // (local mode, or a facade/test that injects one) — otherwise the SPA would offer a Start
  // button that 503s. Local pre-sets its own descriptor before calling in, so this ??= is
  // skipped there; the check covers a stock Node build (false) and the conformance harness
  // (which injects a fake transport via `overrides` → true).
  const previewTransportWired = Boolean(
    options.previewTransport ?? options.overrides?.previewTransport,
  )
  // The Node service has no built-in per-run container runtime: repo-operating agents run on
  // a self-hosted runner pool, and Tester environments via the environment provider. Surface
  // that so the SPA's infrastructure selector reads accurately. Local mode pre-sets its own
  // descriptor (host Docker + pool) before calling in, so only fill it when absent.
  config.infrastructure ??= buildInfrastructureCapabilities({
    execution: { available: ['runner-pool'], active: 'runner-pool' },
    testEnv: { available: ['environment-provider'], active: 'environment-provider' },
    frontendPreview: { supported: previewTransportWired },
    // A remote Node deployment has account admins to govern the account-wide model policy.
    // (Local mode sets `config.infrastructure` itself before delegating here, so its
    // mothership-gated value wins over this `??=`.)
    modelPolicy: { supported: true },
  })
  const clock = new SystemClock()
  const idGenerator = new CryptoIdGenerator()
  // Mothership mode runs with NO Postgres (`options.db` undefined): org/durable state is served
  // remotely via `options.repos`, so that set is REQUIRED there. (A standard Node/local build
  // passes `db` and we build the Drizzle set from it.)
  if (!options.repos && !options.db) {
    throw new Error(
      'buildNodeContainer requires `repos` when `db` is undefined (mothership mode supplies the ' +
        'composite remote + local-credential repositories).',
    )
  }
  const repos = options.repos ?? createDrizzleRepositories(options.db as DrizzleDb, clock)
  // The Drizzle constructors only stash the handle — no build-time work (audited) — so BUILDING
  // the stores below over an `undefined` db is safe; `db` carries the non-null type for those
  // constructions, and the per-user credential services take the OPTIONAL `options.db` and turn
  // themselves off when it is absent.
  const db = options.db as DrizzleDb
  // Mothership mode (`options.db` undefined): the org/durable stores a standard build constructs
  // directly from the db — the GitHub installation + projections, runner-pool connection,
  // bootstrap + env-config-repair job stores, notifications, reference-architecture library,
  // task + subscription-activation stores — are sourced from the REMOTE registry instead (here
  // `options.repos` is the full-surface remote `Proxy` from `composeMothership`, which forwards
  // any repo name to the mothership over RPC). `pickRepoSource(remoteRepos, name, build)` picks
  // the remote entry when there is no db, else builds the Drizzle repo — see the Phase-3 audit in
  // docs/initiatives/mothership-mode.md. The feature-flagged integration repos owned by the
  // sub-helpers (tasks/documents/environments/fragments/slack) are opt-in and off by default, so
  // they are NOT on the default board-load + run path and remain a follow-up sub-slice.
  const remoteRepos = options.db ? undefined : (repos as unknown as Record<string, unknown>)
  // `remoteRepos` + `db` are fixed for this build, so bind them once: `sourced('name', (d) => …)`
  // picks the remote registry entry in mothership mode, else builds the Drizzle repo over `db`.
  const sourced = <T>(name: string, build: (d: DrizzleDb) => T): T =>
    pickRepoSource(remoteRepos, name, () => build(db))

  // The app-owned registries (backend kinds, agent kinds, gates, step resolvers, initiative
  // presets, VCS providers, gate-provider registry) — injected instances when supplied (a
  // deployment's custom entries / the conformance harness) else the built-ins-only defaults.
  // The SAME instances flow to the executors, createCore, and the ServerContainer projection.
  const registries = resolveNodeAppRegistries(options)
  const { vcsRegistry } = registries

  // The built-in gates' providers are wired onto the app-owned `providerRegistry` (fresh unless
  // injected via `options`). The GitHub + release-health wiring runs only inside its
  // `enabled`/`githubClient` branches; a fresh registry starts empty, so an unconfigured gate just
  // stays unwired (pass-through) — no reset needed (the former `clearGateProviders()` guarded a
  // module-global that no longer exists). Mirrors the Worker facade (keep the runtimes symmetric).
  // Any test-injected gate providers (`options.gateProviders`) are applied at the END of this build
  // so they OVERRIDE the config wiring (local mode wires a PAT-backed CI provider here that would
  // otherwise clobber a faked one) — gates read their provider lazily at probe time, last write wins.
  let gitlabEngineClient: GitHubClient | undefined
  if (config.gitlab.enabled && env.GITLAB_TOKEN) {
    registerGitLab(vcsRegistry, {
      tokenSource: new StaticGitLabTokenSource(env.GITLAB_TOKEN, config.gitlab.apiBase),
      clock,
      webhookSecret: config.gitlab.webhookSecret || undefined,
      logger,
    })
    // Bridge the GitLab VcsClient onto the legacy GitHubClient port the engine's gate / merge /
    // RepoFiles paths consume, so a GitLab-only deployment (no GitHub App) gates on real CI and
    // merges the MR for real — the SAME wiring local mode already does, now on the Node facade
    // too (keep the runtimes symmetric). The GitHub App client wins when both are configured.
    gitlabEngineClient = buildGitLabEngineClient({
      token: env.GITLAB_TOKEN,
      apiBase: config.gitlab.apiBase,
      clock,
      logger,
    })
  }

  // Where a run's containers clone from, a deployment-level fact like the GitLab engine client
  // above, and resolved here so the three run-path consumers (the transport's clone target, the
  // container executor, the PR report publisher) cannot end up with different answers. An
  // injected resolver wins (local mode routes on its live credential); otherwise it is DERIVED
  // from this deployment's own config, so a hosted GitLab-only deployment clones its GitLab host
  // rather than falling through to `githubRepoOrigin` and handing every container a `github.com`
  // URL for a project that lives elsewhere.
  //
  // The allow-list half (`harnessGitLabHost`) has NO wiring here on purpose, and its absence is
  // the operator step this facade cannot take for them. Node dispatches to a workspace's
  // SELF-HOSTED runner pool: the harness container is theirs, started by their infrastructure,
  // and nothing in this process sets its environment. So a GitLab deployment sets
  // `GITHUB_ALLOWED_HOSTS` on that container itself, documented in
  // `docs/environment-variables.md` and on the website's runner-pool page. The Worker (which owns
  // its containers) and local mode (which owns its transport) both derive and set it.
  const resolveRepoOrigin = options.resolveRepoOrigin ?? deploymentRepoOrigin(config)

  // Honour the workspace's model presets at run time (block-pinned > the task's
  // selected/default model preset > env routing), uniformly for inline and container
  // kinds. The built-in default preset points every agent kind at Kimi K2.7.
  // Both go through the shared `modelPreset` cache slice: the preset row is slow-moving admin
  // config that the run path resolves on every dispatch, every inline call and every start guard.
  const modelPresetCache = options.caches?.modelPreset
  const resolveWorkspaceModelDefault = (
    workspaceId: string,
    agentKind: string,
    modelPresetId?: string,
  ) =>
    resolvePresetModelForKind(
      repos.modelPresetRepository,
      workspaceId,
      agentKind,
      modelPresetId,
      modelPresetCache,
    )

  // Its sibling: the ORDER that preset prefers a model's routes in. Read from the same repo (and,
  // inside the helper, the same row) so a preset cannot pick the model on one surface and the
  // route order on another.
  const resolvePresetPreference = (workspaceId: string, modelPresetId?: string) =>
    resolvePresetProviderPreference(
      repos.modelPresetRepository,
      workspaceId,
      modelPresetId,
      modelPresetCache,
    )

  return {
    env,
    config,
    clock,
    idGenerator,
    repos,
    db,
    remoteRepos,
    sourced,
    registries,
    gitlabEngineClient,
    resolveRepoOrigin,
    resolveWorkspaceModelDefault,
    resolvePresetProviderPreference: resolvePresetPreference,
  }
}

/** The app-owned registry set {@link resolveNodeAppRegistries} produces. */
export type NodeAppRegistriesResult = ReturnType<typeof resolveNodeAppRegistries>

/** Everything {@link resolveNodeContainerFoundation} hands the composition root. */
export type NodeContainerFoundation = ReturnType<typeof resolveNodeContainerFoundation>
