import {
  CryptoIdGenerator,
  DrizzleEnvironmentUserHandlerRepository,
  DrizzleGitHubInstallationRepository,
  DrizzleLocalSettingsRepository,
  DrizzleRunnerPoolConnectionRepository,
  ProvisioningLogRecorder,
  SystemClock,
  buildNodeContainer,
  buildNodeResolveTransport,
  createDrizzleRepositories,
  executionRuntime,
  loadNodeConfig,
  withProvisioningLog,
} from '@cat-factory/node-server'
import type { CoreRepositories, NodeContainerOptions } from '@cat-factory/node-server'
import {
  SqliteWorkRunner,
  type MothershipComposition,
  composeMothership,
  createMothershipConnector,
  isMothershipMode,
} from './mothership.js'
import { ConflictError, MODEL_PRESET_SEED_IDS } from '@cat-factory/kernel'
import { WorkspaceSettingsService } from '@cat-factory/orchestration'
import { buildInfrastructureCapabilities, logger, RunnerJobClient } from '@cat-factory/server'
import type { AppConfig, ResolveRunnerTransport, ServerContainer } from '@cat-factory/server'
import type { CoreDependencies } from '@cat-factory/orchestration'
import {
  LocalSettingsService,
  composeEnvironmentBackend,
  createBackendRegistries,
} from '@cat-factory/integrations'
import type {
  HarnessKind,
  RunnerPoolConnectionRepository,
  RunnerTransport,
} from '@cat-factory/kernel'
import { NativeRoutingRunnerTransport } from './NativeRoutingRunnerTransport.js'
import {
  detectHostInlineClis,
  makeInlineHarnessPredicate,
  wrapResolverWithInlineHarness,
} from './harnessInline.js'
import { buildLocalDeployTransport } from './NativeCliDeployTransport.js'
import { applyLocalDefaults } from './config.js'
import { OFF_VALUES } from './envFlags.js'
import {
  buildVcsIdentityRegistry,
  createDelegatedGitHubClient,
  createLocalGitHubClient,
  createLocalGitLabClient,
  fetchPatAccount,
  githubPatCreationUrl,
  gitlabPatCreationUrl,
  gitlabVcsHost,
} from './github.js'
import type { GitHubClient, VcsProvider } from '@cat-factory/kernel'
import type { ResolveRepoOrigin } from '@cat-factory/server'
import { AutoProvisioningInstallationRepository, type PatAccount } from './installations.js'
import {
  type LocalContainerRunnerTransport,
  createLocalContainerTransportFromEnv,
} from './LocalContainerRunnerTransport.js'
import {
  LocalProcessRunnerTransport,
  createLocalProcessTransportFromEnv,
} from './LocalProcessRunnerTransport.js'
import { createLocalPreviewTransportFromEnv } from './LocalPreviewTransport.js'
import { resolveHarnessImage } from './harnessImage.js'
import { createRuntimeAdapter, resolveRuntimeId, runtimeProfile } from './runtimes/index.js'
import { createDockerComposeRuntime } from './compose.js'
import { createDockerPreflightProbes } from './preflight.js'

// The local-mode composition root. It is intentionally thin: the ENTIRE Drizzle/
// Postgres persistence, pg-boss durable execution, gateways and model provisioning
// come from `buildNodeContainer` unchanged. Local mode only swaps the differentiators
// behind the seams `buildNodeContainer` exposes:
//   - the runner backend → host Docker by default (a per-run local container,
//     LocalContainerRunnerTransport, Docker/Podman/OrbStack/Colima/Apple `container`,
//     with the warm pool + per-repo checkout reuse configured from the DB local-mode
//     settings), but PER WORKSPACE it can be delegated to the workspace's registered
//     self-hosted runner pool (the `delegateAgentsToRunnerPool` setting) — the
//     local-vs-external opt-in, so a developer runs agents locally by default but can flip
//     them to an external runner pool from the UI;
//   - optional NATIVE execution: run agents as a host process driving the developer's own
//     installed `claude` / `codex` CLI (ambient login), bypassing Docker for the steps that
//     use that login (`LOCAL_NATIVE_AGENTS`); everything else still runs in a container;
//   - the push/clone token → a static source-control PAT (`GITHUB_PAT`, or `GITLAB_PAT` for
//     a GitLab deployment) instead of a GitHub App installation token; the same token also
//     backs the VCS client the CI / merge / mergeability gates + repo-link flows read through
//     (GitHub via the PAT client, GitLab via FetchGitLabClient adapted to the GitHubClient port).
// Repo resolution is unchanged: the executor still resolves a block's repo from the
// `github_repos` / `github_installations` projection (seed those rows for a target
// repo with the link helper). So a developer can run coder/mocker/playwright/
// blueprints/ci-fixer/merger jobs entirely locally, pushing real branches and opening
// real PRs on github.com via the PAT.

/**
 * Resolve the local facade's persistence backing in one place: mothership mode (remote RPC org
 * repos + local `node:sqlite` credentials/work-queue, `db` left undefined) vs the standard
 * siloed-Postgres local mode (Drizzle repos over the local db). `repos` prefers an explicitly
 * injected set (the conformance harness), then the mothership composite, then Drizzle over `db`.
 * The `mothership` composition (when present) also carries the credential store + work queue the
 * caller threads into `buildNodeContainer`.
 */
function resolveLocalPersistence(
  options: NodeContainerOptions,
  env: NodeJS.ProcessEnv,
  clock: SystemClock,
): { mothership: MothershipComposition | undefined; repos: CoreRepositories } {
  const mothership = isMothershipMode(env) && !options.db ? composeMothership(env) : undefined
  const repos =
    options.repos ??
    mothership?.repos ??
    createDrizzleRepositories(options.db as Parameters<typeof createDrizzleRepositories>[0], clock)
  return { mothership, repos }
}

export function buildLocalContainer(options: NodeContainerOptions): ServerContainer {
  const env = applyLocalDefaults(options.env ?? process.env)
  // One shared clock/idGenerator, reused by the per-workspace transport chooser below AND
  // threaded into `buildNodeContainer` (which would otherwise build its own) so the chooser
  // reads the same workspace settings the rest of the engine does. Created up front because the
  // mothership-vs-Postgres persistence decision (which needs the clock) is resolved next.
  const clock = new SystemClock()
  const idGenerator = new CryptoIdGenerator()
  // Mothership mode (docs/initiatives/mothership-mode.md): no local Postgres. Org/durable state
  // is served remotely (RPC) and credentials stay local (node:sqlite); `repos` is then the
  // remote (RPC-backed) composite, threaded through the existing NodeContainer seams with `db`
  // left undefined, and the in-process work runner replaces pg-boss. Off → the standard
  // siloed-Postgres local mode is unchanged (`repos` is the Drizzle set over the local Postgres).
  const { mothership, repos } = resolveLocalPersistence(options, env, clock)
  const pat = env.GITHUB_PAT?.trim()
  const gitlabPat = env.GITLAB_PAT?.trim()
  // The push/clone token and the VCS client are provider-agnostic. Prefer a GitHub PAT, else
  // fall back to a GitLab PAT, so a GitLab-only local deployment still (a) authenticates the
  // agent containers' git clone/push — the harness uses a host-neutral GIT_ASKPASS credential,
  // so the same token drives github.com or gitlab.com — and (b) gates on CI + merges through
  // the GitLab API via the VcsClient→GitHubClient adapter. `gitToken` is what the harness
  // pushes with; `vcsClient` is what the gates/merger/repo-link read through.
  const gitToken = pat ?? gitlabPat
  // Mothership-mode GitHub delegation: with NO local PAT, GitHub is reached on installation
  // tokens the MOTHERSHIP mints over the machine API (`/internal/github/installation-token`) —
  // the org's GitHub App backs the laptop's agent containers, gates/merge, RepoFiles ops and
  // the environment self-test, with no App key or long-lived credential on this machine. An
  // explicitly configured PAT (GitHub or GitLab) wins; delegation is the no-PAT default.
  const delegatedGitHub = mothership && !gitToken ? mothership.githubTokenSource : undefined
  const vcsClient: GitHubClient | undefined = pat
    ? // The picker-typeahead enumeration cache (`AppCaches.patInstallationRepos`). `start()`
      // passes the process cache bag through; a mothership boot / test harness without one
      // degrades to a live enumeration per search, unchanged.
      createLocalGitHubClient(env, options.caches?.patInstallationRepos)
    : gitlabPat
      ? createLocalGitLabClient(env)
      : delegatedGitHub
        ? createDelegatedGitHubClient(env, delegatedGitHub)
        : undefined
  // When GitLab is the active backend (no GitHub PAT), the agent containers must clone the
  // GitLab host and open merge requests — not github.com. The repo projection carries no host,
  // so build the clone URL + provider from the configured GitLab host here. Same host the
  // harness allow-list is widened to (`harnessAllowedHosts`), so they can't disagree.
  const gitlabHost = pat ? undefined : gitlabPat ? gitlabVcsHost(env) : undefined
  // Local mode is single-provider: GitLab when a GitLab host was resolved, GitHub otherwise
  // (GitHub PAT or mothership delegation). The synthetic connection is stamped with it.
  const deploymentProvider: VcsProvider = gitlabHost ? 'gitlab' : 'github'
  const resolveRepoOrigin: ResolveRepoOrigin | undefined = gitlabHost
    ? (repo) => ({
        cloneUrl: `https://${gitlabHost}/${repo.owner}/${repo.name}.git`,
        provider: 'gitlab',
      })
    : undefined
  const base = options.config ?? loadNodeConfig(env)
  // Tag the config as local mode and, when no PAT is set, carry the (scopes-preselected)
  // creation URL so the SPA can surface it as a dismissible banner — the server-side warn
  // log alone is easy to miss in a dev terminal. With a PAT, force the GitHub integration
  // ON: the Node loader only enables it for a configured GitHub App, but local mode reaches
  // GitHub through the PAT-backed client, so the read/link endpoints (connection, available
  // repos, "add from existing repo") should be served the same way.
  // Native local execution (opt-in): run agents as a host process driving the developer's
  // OWN installed `claude` / `codex` CLI (ambient login), bypassing Docker. The env is the
  // ALLOW-LIST of subscription harnesses to run natively (`claude-code,codex`); parsed into
  // a harness set so the executor flags `ambientAuth` ONLY for a listed harness whose vendor
  // is that CLI's native vendor (Claude/Codex), and the personal-credential gate skips just
  // those vendors. Default off — the container path is unchanged.
  const nativeHarnesses = parseNativeHarnesses(env.LOCAL_NATIVE_AGENTS, (message) =>
    logger.warn(message),
  )
  const nativeAgents = nativeHarnesses.length > 0
  // Inline subscription execution (DEFAULT ON, `LOCAL_NATIVE_INLINE`): which subscription
  // harnesses may serve the INLINE LLM steps (requirements reviewer, brainstorm, task-estimator,
  // inline document kinds) on the developer's ambient `claude` / `codex` CLI. This is DECOUPLED
  // from `LOCAL_NATIVE_AGENTS` above: that opt-in governs running whole CONTAINER agents
  // unsandboxed on the host; an inline step is just a one-shot text call (no repo, no tools), so
  // running it on the local CLI is benign and defaults on. It is what lets a subscription-only
  // preset (everything pinned to `claude-opus`/GPT) run its inline reviewers in BOTH local and
  // mothership mode — both boot through this facade on the developer's machine, so the host CLI
  // is reachable in either. Off via `LOCAL_NATIVE_INLINE=off`.
  const inlineHarnesses = parseInlineHarnesses(env.LOCAL_NATIVE_INLINE, (message) =>
    logger.warn(message),
  )
  const inlineAgents = inlineHarnesses.length > 0
  // The source-control PAT-login registry (GitHub + GitLab), assembled provider-agnostically
  // from env. `configured` providers (their PAT is set in env) offer a "Sign in with configured
  // <provider> PAT" button — the only sign-in path, since that env token is also the operational
  // credential. Advertised on `localMode.patLogin` so the login screen renders the right
  // buttons, and exposed on the container for the `/auth/pat` endpoint.
  const { registry: vcsIdentity, configured } = buildVcsIdentityRegistry(env)
  const config: AppConfig = {
    ...base,
    // Enable the (provider-neutral) source-control integration for EITHER PAT — or for
    // mothership-delegated GitHub: the read/link endpoints + gates are served through
    // `vcsClient`, PAT- or delegation-backed alike.
    ...(gitToken || delegatedGitHub ? { github: { ...base.github, enabled: true } } : {}),
    ...(nativeAgents ? { nativeAmbientAuth: nativeHarnesses } : {}),
    // Inline LLM steps (requirements reviewer, brainstorm, task-estimator, inline document kinds)
    // run on a subscription model through the developer's ambient `claude`/`codex` CLI — so a
    // subscription-only preset no longer strands them (or trips the preset-satisfiability guard).
    // Gated by `LOCAL_NATIVE_INLINE` (default on), NOT `LOCAL_NATIVE_AGENTS`: the inline predicate
    // matches the ambient-native vendors in that set, and `wrapModelProviderResolver` below serves
    // those refs via the CLI. Off (`LOCAL_NATIVE_INLINE=off`) → inline steps degrade to a
    // provider model as on stock Node, and the start guard refuses a subscription-only inline step.
    ...(inlineAgents
      ? {
          agents: {
            ...base.agents,
            inlineHarnessRef: makeInlineHarnessPredicate(inlineHarnesses),
          },
        }
      : {}),
    localMode: {
      enabled: true,
      // Surfaced to the SPA so it can label what is stored locally (credentials) vs delegated
      // to the mothership (org/durable state), and (in mothership mode) where to send the user
      // to sign in. Off → the standard siloed-Postgres local mode.
      ...(mothership ? { mothership: true, mothershipUrl: env.LOCAL_MOTHERSHIP_URL?.trim() } : {}),
      // No "create a PAT" banner when GitHub rides mothership delegation — a PAT is optional there.
      ...(gitToken || delegatedGitHub ? {} : { githubPatSetupUrl: githubPatCreationUrl() }),
      // Scopes-preselected "create a PAT" deep links so the "no token configured" notice sends
      // the developer straight to the right token page (scopes differ per provider).
      patLogin: {
        configured,
        setupUrls: { github: githubPatCreationUrl(), gitlab: gitlabPatCreationUrl() },
      },
    },
  }

  // Local mode has no GitHub-App connect flow, so a workspace's installation is conjured
  // from the PAT on first read (see AutoProvisioningInstallationRepository): the synthetic
  // row makes `getConnection` report connected and gives the sync service an installation
  // id to list/link repos under. The PAT account is fetched once and shared across
  // workspaces (a single developer's token).
  let accountPromise: Promise<PatAccount> | undefined
  const resolveAccount = () => (accountPromise ??= fetchPatAccount(env))
  const githubInstallationRepository =
    gitToken && options.db
      ? new AutoProvisioningInstallationRepository(
          new DrizzleGitHubInstallationRepository(options.db),
          resolveAccount,
          deploymentProvider,
        )
      : undefined

  const wsSettings = new WorkspaceSettingsService({
    workspaceSettingsRepository: repos.workspaceSettingsRepository,
    workspaceRepository: repos.workspaceRepository,
  })

  // The local container transport is constructed LAZILY on first dispatch, so the service
  // still boots to serve the board (and inline kinds) even when no container runtime is up.
  // LOCAL_HARNESS_IMAGE is optional — unset ⇒ the backend-matched RECOMMENDED_HARNESS_IMAGE —
  // so container kinds run on the matched image by default; they fail loudly (with a clear
  // message) only when the runtime/image genuinely can't be reached, mirroring how the Node
  // facade treats a missing runner backend.
  //
  // Native mode does NOT blanket-route every dispatch to the host process: a host process
  // has no sandbox, so only the steps that actually use the developer's ambient CLI login
  // (flagged `ambientAuth` by the executor) run there. Everything else — a proxy/`pi` model,
  // or a non-native vendor reusing the claude-code harness — still runs in a per-run
  // container (built lazily, so a Claude/Codex-only native deployment never needs an image;
  // a proxy step without one fails loudly there). See NativeRoutingRunnerTransport.
  // Local-mode operational settings (warm-pool sizing + per-repo checkout reuse) live in
  // the DB as a per-deployment singleton, edited through the dedicated local-mode settings
  // panel — they REPLACED the old LOCAL_POOL_* / HARNESS_* env vars. Built here so the
  // serving transport resolves its pool config from it and the local-settings controller
  // can read/write it. Requires the Drizzle db (always present for the local service).
  // The serving container transport is built once, lazily, reading its pool + checkout
  // config from the DB settings (not env). The promise is cached so every dispatch — and
  // the native router's container leg — reuses the same instance (and its in-process pool).
  // A settings edit is applied LIVE to this instance (see the service's `onChange` below),
  // so the panel takes effect without a restart.
  let containerTransport: Promise<LocalContainerRunnerTransport> | undefined

  // The warm-pool + checkout config repo: Drizzle over the local Postgres (siloed local mode),
  // else the local `node:sqlite` singleton in mothership mode (no Postgres, but these settings
  // configure the LOCAL Docker runner — the local facade's own differentiator — so they belong on
  // the laptop, not the mothership). Either way the panel persists + reads back live.
  const localSettingsRepository = options.db
    ? new DrizzleLocalSettingsRepository(options.db)
    : mothership?.localSettingsStore.localSettingsRepository
  const localSettingsService = localSettingsRepository
    ? new LocalSettingsService({
        localSettingsRepository,
        clock: { now: () => Date.now() },
        // Apply an edit to the already-built serving transport so the warm-pool + checkout
        // config takes effect WITHOUT a restart. No-op until the transport is built (the
        // next build reads the fresh settings anyway); a still-failing build is swallowed
        // (a later dispatch surfaces the real problem with a clearer message).
        onChange: async (settings) => {
          if (!containerTransport) return
          try {
            ;(await containerTransport).applySettings(settings)
          } catch {
            // transport build is still failing — nothing to reconfigure yet
          }
        },
      })
    : undefined
  const buildServingTransport = async (): Promise<LocalContainerRunnerTransport> => {
    const settings = await localSettingsService?.resolve()
    const transport = createLocalContainerTransportFromEnv(env, settings)
    // Boot housekeeping on the SERVING instance: reap exited per-run containers, drain
    // pool members orphaned by a previous process, and pre-warm to poolMinWarm. Best
    // -effort — if the container runtime is down this throws, but a later dispatch then
    // fails loudly with a clearer message, so swallow it here.
    await transport.reapExited().catch((err) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'local mode: could not reap / pre-warm job containers at startup',
      )
    })
    // Also reap per-run containers left RUNNING by a crashed previous process whose run is
    // now terminal/gone (release() never ran). A run that is still live is left for the
    // stale-run sweeper to re-drive (it re-attaches to the same container by run-id label).
    await transport
      .reapOrphanedRuns((ids) => repos.agentRunRepository.liveRunIds(ids))
      .then((n) => {
        if (n > 0) logger.warn({ reaped: n }, 'local mode: reaped orphaned per-run containers')
      })
      .catch((err) => {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'local mode: could not reap orphaned run containers at startup',
        )
      })
    return transport
  }
  const resolveContainerTransport = (): Promise<LocalContainerRunnerTransport> => {
    if (!containerTransport) {
      containerTransport = buildServingTransport()
      // Don't let a transient build failure (e.g. a DB blip resolving the settings) poison
      // every future dispatch: drop the cached promise on rejection so the next call retries.
      containerTransport.catch(() => {
        containerTransport = undefined
      })
    }
    return containerTransport
  }

  // The local-agents resolver: in native mode the per-job router (only ambient-CLI steps go
  // to the host process, the rest to a container), otherwise the warm-pool container
  // transport directly.
  let routed: RunnerTransport | undefined
  // Held at this scope (not inside the resolver closure) so `onShutdown` below can stop the
  // harness host process gracefully instead of relying on the parent-exit backstop kill.
  let nativeProcessTransport: LocalProcessRunnerTransport | undefined
  const localAgentsResolve: ResolveRunnerTransport = () => {
    if (nativeAgents) {
      if (!routed) {
        routed = new NativeRoutingRunnerTransport(
          () => (nativeProcessTransport ??= createLocalProcessTransportFromEnv(env)),
          resolveContainerTransport,
        )
      }
      return Promise.resolve(routed)
    }
    return resolveContainerTransport()
  }

  // Eagerly kick off the serving transport's boot housekeeping (reap + pre-warm), so a warm
  // pool is ready before the first run rather than warming on first dispatch. The harness image
  // always resolves now (an explicit LOCAL_HARNESS_IMAGE, else the backend-matched pin — see
  // resolveHarnessImage), so this is no longer gated on the raw env var; a container runtime
  // that's down just makes the fire-and-forget promise reject harmlessly (dispatch reuses the
  // same cached promise and fails loudly then).
  void resolveContainerTransport().catch(() => {})

  // The DEPLOY job client (the async container-backed Kubernetes render lifecycle). Local runs
  // it on a DEDICATED deploy backend — the developer's host `kubectl`/`kustomize`/`helm` (native
  // mode) or a per-job deploy-harness container — NOT the agent transport (which runs the
  // executor-harness image, lacking the k8s CLIs). `LOCAL_DEPLOY_RUNTIME` has NO default: unset ⇒
  // this is null so deploy stays UNWIRED (a render-needing config fails loudly at provision time
  // with an actionable message; the raw-manifest REST path is unaffected) — never silently routed
  // to the agent backend (the `disableDefaultDeployJobClient` flag below stops `buildNodeContainer`
  // falling back). `container` mode works with no other variable (the deploy-harness image defaults
  // to the backend-matched RECOMMENDED_DEPLOY_IMAGE); `native` mode SET without its mandatory
  // LOCAL_DEPLOY_HARNESS_ENTRY companion BREAKS boot here (the thrown ConfigValidationError lands on
  // the misconfigured screen) rather than degrading silently.
  // The clone target is inherited from `buildNodeContainer`'s default, which already uses local's
  // PAT mint + GitLab-aware `resolveRepoOrigin`.
  const localDeployTransport = buildLocalDeployTransport(env)
  const deployJobClient = localDeployTransport
    ? new RunnerJobClient(() => Promise.resolve(localDeployTransport))
    : undefined

  // The runner-pool resolver (the external opt-in target). In local mode `runners` is
  // enabled (it keys off ENCRYPTION_KEY, which `applyLocalDefaults` always sets), so this
  // is non-null and a workspace can register a pool via the API; a native adapter injected
  // through `options.runnerPoolProvider` drives the actual dispatch. The connection repo is
  // also held for the start-time guard's cheap "is a pool registered?" existence check.
  // In mothership mode there is no local db, so resolve this repo REMOTELY (like the rest of the
  // org state) rather than over an undefined db handle — a delegation check then returns a clean
  // gated `unknown_method` (the repo joins the allow-list in the gating phase, see the tracker)
  // instead of a `Cannot read properties of undefined` TypeError.
  const runnerPoolConnectionRepository: RunnerPoolConnectionRepository = mothership
    ? (
        mothership.repos as unknown as {
          runnerPoolConnectionRepository: RunnerPoolConnectionRepository
        }
      ).runnerPoolConnectionRepository
    : new DrizzleRunnerPoolConnectionRepository(options.db!)
  // Build the app-owned backend registries once and share them with BOTH the pool resolver
  // here AND `buildNodeContainer` below (via `backendRegistries`), so the runner backend a
  // workspace's `kind` resolves to is the same instance everywhere. Defaults to the built-ins.
  const backendRegistries = options.backendRegistries ?? createBackendRegistries()
  // Docker Compose ephemeral environments (the Checkbox compose-stack mechanic): register the
  // `compose` env backend by reference, closing over the host docker CLI seam, so a workspace
  // can stand the PR repo's own `docker-compose.yml` up as a Tester preview env. It needs a
  // Docker daemon, so it is registered ONLY on the Docker-family runtimes (Apple `container`
  // can't run compose-on-host the same way — the same asymmetry as `localDind`); the Worker
  // never registers it. A pre-registered `compose` kind (the conformance harness's fake-runtime
  // backend) wins — the guard keeps this real-daemon registration from clobbering it.
  const localRuntimeId = resolveRuntimeId(env)
  // The host Docker seam is shared by the compose ENVIRONMENT backend (per-PR preview stacks) and
  // the SHARED-STACK lifecycle (long-lived infra), so build it once on a Docker-family runtime and
  // thread it into both — the backend registry here, and the core deps via `overrides.composeRuntime`
  // below (so `SharedStackService.ensureUp`/`teardown` can drive the daemon).
  let localComposeRuntime: ReturnType<typeof createDockerComposeRuntime> | undefined
  // Host-bound PREFLIGHT probes (docker daemon / disk / RAM / registry login / reachability /
  // mkcert / hosts / secrets marker) that enforce a stack recipe's `prerequisites` at provision
  // start. Built alongside the compose runtime on a Docker-family runtime (same daemon + binary).
  let localPreflightProbes: ReturnType<typeof createDockerPreflightProbes> | undefined
  if (
    runtimeProfile(localRuntimeId).family === 'docker' &&
    !backendRegistries.environmentBackendRegistry.get('compose')
  ) {
    const composeBinary = env.LOCAL_DOCKER_BINARY?.trim() || runtimeProfile(localRuntimeId).binary
    localComposeRuntime = createDockerComposeRuntime({ binary: composeBinary })
    localPreflightProbes = createDockerPreflightProbes({ binary: composeBinary })
    backendRegistries.environmentBackendRegistry.register(
      composeEnvironmentBackend(localComposeRuntime),
    )
  }
  const poolResolve = buildNodeResolveTransport(
    config,
    runnerPoolConnectionRepository,
    repos.workspaceRepository,
    clock,
    backendRegistries.runnerBackendRegistry,
    options.runnerPoolProvider,
  )

  // Per-branch provisioning-log tagging: the per-run local container logs under the
  // `container` subsystem, the runner pool under `runner-pool`, so the logs drawer filters
  // each correctly. We wrap each branch here and tell `buildNodeContainer` not to re-wrap
  // (its single-subsystem wrap can't tell which branch a per-workspace chooser took).
  const recorder = new ProvisioningLogRecorder({
    repository: repos.provisioningLogRepository,
    idGenerator,
    clock,
  })
  const wrappedLocal = withProvisioningLog(localAgentsResolve, recorder, 'container')!
  const wrappedPool = poolResolve ? withProvisioningLog(poolResolve, recorder, 'runner-pool') : null

  // The local-vs-external agents opt-in: dispatch to the registered runner pool when the
  // workspace opts in (and one is wrapped), else to host Docker (the warm-pool / native
  // local backend). The pool branch's own throw surfaces a clean "register a pool" message
  // when delegation is on but none exists.
  const resolveTransport: ResolveRunnerTransport = async (workspaceId) => {
    const delegate = !!workspaceId && (await wsSettings.get(workspaceId)).delegateAgentsToRunnerPool
    if (delegate && wrappedPool) return wrappedPool(workspaceId)
    return wrappedLocal(workspaceId)
  }

  // Start-time guard: refuse a run up front when the workspace delegates agents to a pool
  // that isn't registered, so the human gets a clean 409 (an actionable message) instead of
  // a mid-run dispatch failure. No-op when delegation is off. We throw a ConflictError for
  // BOTH negative cases — the integration being disabled AND no pool registered for the
  // workspace — rather than letting the pool resolver's plain Error escape (the error
  // handler maps a non-DomainError to an opaque 500 with the message suppressed). The
  // existence check uses `getByWorkspace` directly, so it neither decrypts the pool secrets
  // nor builds a transport that the actual dispatch resolve would only build again.
  const assertAgentBackendConfigured = async (workspaceId: string): Promise<void> => {
    if (!(await wsSettings.get(workspaceId)).delegateAgentsToRunnerPool) return
    if (!wrappedPool) {
      throw new ConflictError(
        'This workspace delegates container agents to a self-hosted runner pool, but the ' +
          'runner-pool integration is not enabled on this deployment.',
        'agent_backend_unconfigured',
      )
    }
    if (!(await runnerPoolConnectionRepository.getByWorkspace(workspaceId))) {
      throw new ConflictError(
        'This workspace delegates container agents to a self-hosted runner pool, but none ' +
          'is registered. Register one (Settings → Self-hosted runner pool) or turn ' +
          'delegation off to run agents on host Docker, before starting.',
        'agent_backend_unconfigured',
      )
    }
  }

  // The selected runtime decides whether the Tester's LOCAL docker-compose infra (run
  // via Docker-in-Docker) is possible: Docker/Podman/OrbStack/Colima can nest a daemon,
  // Apple `container` (one VM per container) cannot. Surface that capability to the
  // engine so it refuses a local-infra Tester run on an incapable runtime ("limited
  // mode") instead of dispatching a job that can't stand its dependencies up. Building
  // the adapter is pure (no IO), so this is cheap even though the transport stays lazy.
  // Native mode runs agents on the host with no per-run Docker container; the Tester's
  // local docker-compose infra (host compose with per-run project names) is a later phase,
  // so it's reported unsupported for now (the engine steers to "limited mode"). The
  // container path keeps the runtime's real Docker-in-Docker capability.
  const localTestInfraSupported = nativeAgents
    ? false
    : createRuntimeAdapter(env).capabilities.localDind

  // Surface the local deployment's execution backends so the SPA renders a clear selector.
  // Agents run on host Docker (`local-docker`) by default, flipping to the self-hosted pool
  // per-workspace via `delegateAgentsToRunnerPool` (the SPA derives the effective active).
  // The Tester's in-container docker-compose infra (`local-compose`) is offered ONLY when the
  // runtime can nest containers — Apple `container` can't, so it's omitted there (the one
  // legitimate per-runtime asymmetry, gated by `localTestInfraSupported`/`localDind`).
  config.infrastructure = buildInfrastructureCapabilities({
    execution: {
      available: ['local-docker', 'runner-pool'],
      active: 'local-docker',
      // Prefill the image of a low-config k3s runner preset — local mode knows its harness ref
      // (an explicit LOCAL_HARNESS_IMAGE, else the backend-matched RECOMMENDED_HARNESS_IMAGE).
      suggestedExecutorImage: resolveHarnessImage(env),
    },
    testEnv: {
      available: localTestInfraSupported
        ? ['local-compose', 'environment-provider']
        : ['environment-provider'],
      active: localTestInfraSupported ? 'local-compose' : 'environment-provider',
    },
    // Local mode runs on the developer's own machine, so a built frontend can be served on a
    // host-reachable URL for a browsable preview — the genuine local/node differentiator over
    // the Worker's self-contained UI-test container.
    frontendPreview: { supported: true },
    // The account-wide model policy needs an account admin governing a shared tenant. Plain
    // local mode is a single developer on their own machine (no such governance), so it is
    // unsupported there; mothership mode delegates org state to a hosted account, so it is on.
    modelPolicy: { supported: !!mothership },
  })

  // Mothership mode has no pg-boss: drive runs in-process through the SAME advance/poll loop with
  // real timer-backed sleeps, backed by the durable local-sqlite work queue (so a crash/restart
  // re-drives what was in flight — the durability pg-boss gives the Node facade). Bound to the
  // execution service AFTER the container is built (the service doesn't exist yet — chicken-and-egg
  // with createCore). The lease/sweeper timings reuse the same execution-runtime derivation the
  // pg-boss queue/sweeper use, so durable recovery behaves consistently across the two runners.
  const runtime = mothership ? executionRuntime(config, env) : undefined
  const inProcessRunner =
    mothership && runtime
      ? new SqliteWorkRunner(
          mothership.workQueue,
          {
            drive: runtime.drive,
            leaseMs: runtime.queue.expireInSeconds * 1000,
            reArmDelayMs: Math.max(1000, runtime.drive.ciPollIntervalMs),
            errorBackoffMs: Math.max(1000, runtime.drive.ciPollIntervalMs),
            sweepIntervalMs: runtime.sweeper.intervalMs,
            maxAttempts: runtime.queue.retryLimit,
            concurrency: runtime.concurrency,
          },
          logger,
        )
      : undefined

  const container = buildNodeContainer({
    ...options,
    env,
    config,
    repos,
    // Local mode seeds a fresh workspace's model-preset library with Claude Opus 4.8 as the
    // default: the local facade runs subscription-only models (via the developer's ambient
    // `claude` CLI for inline steps + a leased personal credential for container steps), so
    // Claude is a first-class default here even though it can't run on the bare Cloudflare
    // baseline. Overridable (the conformance harness passes Kimi so its fake-executor runs
    // resolve to a Cloudflare-usable model). Applied only at first seed — a user's later
    // manual default choice always wins.
    defaultModelPresetId: options.defaultModelPresetId ?? MODEL_PRESET_SEED_IDS.claude,
    // Mothership credentials stay on the laptop: inject the local node:sqlite store's repos so
    // the API-key pool, local-model endpoints, AND the subscription credentials (pooled tokens +
    // per-user personal creds + their per-run activations) are sealed with the LOCAL key and
    // leased by the LOCAL container executor — the mothership's ENCRYPTION_KEY never reaches this
    // machine. Off → Drizzle over Postgres. `subscriptionActivationRepository` is threaded ONCE
    // here and reused by BOTH consumers in buildNodeContainer (the personal-subscription service's
    // mint + the engine core's clear-on-completion), so they agree on one store.
    ...(mothership
      ? {
          providerApiKeyRepository: mothership.credentialStore.providerApiKeyRepository,
          localModelEndpointRepository: mothership.credentialStore.localModelEndpointRepository,
          providerSubscriptionTokenRepository:
            mothership.credentialStore.providerSubscriptionTokenRepository,
          personalSubscriptionRepository: mothership.credentialStore.personalSubscriptionRepository,
          subscriptionActivationRepository:
            mothership.credentialStore.subscriptionActivationRepository,
        }
      : {}),
    // Share the SAME registries the pool resolver above was built with (so a custom runner
    // backend resolves to one instance across the local chooser + the engine's connection service).
    backendRegistries,
    // The per-workspace chooser (host Docker / native local vs the runner pool). Pre-wrapped
    // with the correct provisioning-log subsystem per branch, so tell buildNodeContainer not
    // to re-wrap with a single subsystem tag.
    resolveTransport,
    // Deploy runs on its OWN backend (native host CLIs / a deploy-image container), never the
    // agent transport — so suppress buildNodeContainer's pool-backed default and inject ours
    // (absent ⇒ deploy unwired, render configs fail loudly).
    disableDefaultDeployJobClient: true,
    ...(deployJobClient ? { deployJobClient } : {}),
    skipProvisioningLogWrap: true,
    // Local mode defaults binary-artifact (screenshot) storage to the on-disk filesystem
    // backend (`.file-storage`), so UI-tester screenshots work out of the box with no setup;
    // an account can still switch to S3 in the UI. (Node mode defaults to `off` — storage
    // there requires explicit per-account configuration.)
    contentStorageDefaultBackend: 'fs',
    // Authenticate git with the developer's PAT when present (GitHub or GitLab — the harness
    // credential is host-neutral); in mothership mode without a PAT, mint the per-installation
    // push/clone token from the mothership's GitHub App instead. Absent both → the executor
    // falls back to the GitHub App path (and is null without it), so container kinds fail
    // loudly rather than silently mis-running.
    ...(gitToken
      ? { mintInstallationToken: async () => gitToken }
      : delegatedGitHub
        ? { mintInstallationToken: (id: number) => delegatedGitHub.installationToken(id) }
        : {}),
    // The PAT-backed VCS client wires the CI gate + merge / mergeability providers, so a local
    // pipeline gates on real CI and merges the PR/MR for real, AND serves the read/link
    // endpoints. GitHub uses the PAT client (repos via /user/repos); GitLab uses the
    // FetchGitLabClient adapted to the same GitHubClient port.
    ...(vcsClient ? { githubClient: vcsClient } : {}),
    // For a GitLab backend, make agent containers clone the GitLab host + open MRs (without
    // this the clone URL is always github.com, so a GitLab repo can't be cloned).
    ...(resolveRepoOrigin ? { resolveRepoOrigin } : {}),
    // Browsable frontend preview (slice 5c): the local Docker/Apple adapter can publish a served
    // app's port to the host + keep the container alive, so local mode wires the real preview
    // transport (buildNodeContainer builds the job builder from local's PAT-backed seams). The
    // capability was already advertised `frontendPreview.supported: true` above.
    previewTransport: createLocalPreviewTransportFromEnv(env),
    // Serve enabled subscription harness refs (Claude Code / Codex + the non-native
    // claude-code vendors GLM/Kimi/DeepSeek) as INLINE calls: the developer's OWN host CLI
    // when its binary is present (ambient login, unmetered), else a warm CONTAINER on a LEASED
    // subscription credential — so the inline reviewers/brainstorm/estimator + inline agent
    // kinds run on the subscription even without a host CLI (and in mothership mode). Gated by
    // `LOCAL_NATIVE_INLINE` (default on), independent of the container-native opt-in above. The
    // per-run personal / pooled lease seams are supplied by `buildNodeContainer` (built from the
    // same subscription services the container executor uses) via the wrap `deps` argument.
    ...(inlineAgents
      ? {
          wrapModelProviderResolver: (inner, leaseDeps) =>
            wrapResolverWithInlineHarness({
              inlineHarnesses,
              hostCliVendors: detectHostInlineClis(env),
              runInline: (req) => resolveContainerTransport().then((t) => t.runInline(req)),
              ...leaseDeps,
            })(inner),
        }
      : {}),
    // Auto-provision the synthetic per-workspace installation so the integration reports
    // connected with no manual connect step.
    ...(githubInstallationRepository ? { githubInstallationRepository } : {}),
    overrides: {
      // Refuse a run up front when the workspace delegates container agents to a runner pool
      // that isn't registered. Listed BEFORE `...options.overrides` so a caller (the
      // cross-runtime conformance harness) can override it.
      assertAgentBackendConfigured,
      // Shared-stack bring-up/teardown drives the host Docker daemon, so hand the core deps the
      // same runtime the compose env backend uses. Only on a Docker-family runtime; absent ⇒ the
      // lifecycle endpoints refuse (Apple `container` can't nest, like `localDind`).
      ...(localComposeRuntime ? { composeRuntime: localComposeRuntime } : {}),
      // The host-probe seam that enforces a stack recipe's machine `prerequisites` at provision
      // start (and backs the preflight API). Present only on a Docker-family runtime (same gate as
      // the compose runtime above); absent ⇒ the preflight API 503s.
      ...(localPreflightProbes ? { preflightHostProbes: localPreflightProbes } : {}),
      // Clone a shared stack's repo with the same source-control PAT the agent containers push
      // with, so a stack whose `cloneUrl` is a PRIVATE repo can be brought up (else public-only).
      ...(gitToken ? { sharedStackCloneToken: gitToken } : {}),
      ...options.overrides,
      // Mothership mode's in-process work runner (no pg-boss). After `...options.overrides` so an
      // explicit test override still wins; in mothership boot there is no `boss`, so this is the
      // only runner wired.
      ...(inProcessRunner ? { workRunner: inProcessRunner } : {}),
      // The local PAT carries the CI-config scope (GitHub `workflow` — pre-selected by the
      // creation URL; GitLab `api` covers it), so the connection isn't missing that grant —
      // report it granted to suppress the advisory banner. (The App-permissions probe this
      // normally uses needs an app JWT, which a single-token connection has no equivalent of.)
      ...(gitToken
        ? ({ workflowsGranted: async () => true } satisfies Partial<CoreDependencies>)
        : {}),
      // Per-USER infra handler overrides are a LOCAL-mode feature: only the local facade
      // wires the repository, so the per-user override service + controller assemble here
      // (and stay 503 / inert on the Worker + Node facades). A developer can point a
      // provision type at their own Docker / k3s for the runs they initiate. It is backed by
      // local Postgres, so it only wires when a `db` is present — in mothership mode (`db`
      // undefined) there is no local database, so the override service stays inert (503),
      // exactly like `localSettingsService` above; remoting it is a later environments slice.
      ...(options.db
        ? {
            environmentUserHandlerRepository: new DrizzleEnvironmentUserHandlerRepository(
              options.db,
            ),
          }
        : {}),
    } satisfies Partial<CoreDependencies>,
  })

  // Bind the in-process work runner to the now-built execution service, so `startRun` /
  // `signalDecision` drive runs in-process (mothership mode; no-op otherwise). The kind-spanning
  // agent-runs reader powers the storage-reconciliation backstop (re-drive a run still `running` in
  // storage that lost its queue row) — the no-pg-boss analogue of the stale-run sweeper.
  inProcessRunner?.bind(container.executionService, container.agentRunRepository)

  // Surface the local-mode settings service so the dedicated local-settings panel can
  // read/write the warm-pool + checkout config (the controller 503s when this is absent,
  // which is the case on every non-local facade). Also expose the PAT-login registry so the
  // `/auth/pat` endpoint can resolve a GitHub/GitLab identity (local-mode only).
  return {
    ...container,
    vcsIdentity,
    ...(localSettingsService ? { localSettings: { service: localSettingsService } } : {}),
    // Mothership-mode login seam (local facade only): the SPA hands the node a mothership session
    // via `POST /local/mothership/connect`, which forwards it to the mothership's mint endpoint and
    // caches the returned machine token. Absent (503) outside mothership mode.
    ...(mothership && env.LOCAL_MOTHERSHIP_URL?.trim()
      ? {
          mothershipConnect: createMothershipConnector({
            baseUrl: env.LOCAL_MOTHERSHIP_URL.trim(),
            store: mothership.machineTokenStore,
          }),
        }
      : {}),
    // On shutdown (the boot paths call this from their SIGTERM/SIGINT handlers): stop the
    // native host-process harnesses (agent + deploy) so a graceful exit tears them down —
    // aborting their in-flight CLI children — rather than relying on the parent-exit
    // backstop kill; in mothership mode ALSO stop the work runner's recovery poll FIRST so
    // it can't touch the queue mid-close, then release both local SQLite handles.
    onShutdown: async () => {
      if (mothership) {
        inProcessRunner?.stop()
        mothership.close()
      }
      await nativeProcessTransport?.shutdown()
      if (localDeployTransport instanceof LocalProcessRunnerTransport) {
        await localDeployTransport.shutdown()
      }
      // Compose the base Node container's shutdown (flushes/releases the external trace sink)
      // — this override would otherwise drop it, since the return below replaces `onShutdown`.
      await container.onShutdown?.()
    },
  }
}

/** Affirmative values that enable BOTH native harnesses without naming one. */
const NATIVE_ALL_VALUES = new Set(['true', '1', 'on', 'yes', 'all', 'both'])
/** What an affirmative-with-no-harness value (or an unset default-on flag) enables. */
const BOTH_NATIVE_HARNESSES: HarnessKind[] = ['claude-code', 'codex']

/**
 * Shared parser for the two comma-separated subscription-harness allow-lists
 * (`LOCAL_NATIVE_AGENTS`, `LOCAL_NATIVE_INLINE`). The documented form is a list of harness ids
 * (`claude-code,codex`); `claude` is an alias for `claude-code`. An explicit off value
 * (`false`/`0`/`off`/`no`/`none`/`disabled`) ⇒ `[]`; an affirmative keyword naming no harness
 * (`true`/`1`/`on`/…) ⇒ BOTH. Only `claude-code` / `codex` are ever native; any other token is
 * ignored (a value with neither a recognised harness nor an affirmative keyword — e.g. a typo —
 * ⇒ `[]`, warned, so an unintelligible setting fails safe rather than silently doing something).
 * The ONLY difference between the two flags is what an UNSET/blank value yields — `defaults`.
 */
function parseHarnessSet(
  raw: string | undefined,
  opts: { defaults: HarnessKind[]; envName: string; offNote: string },
  onWarn?: (message: string) => void,
): HarnessKind[] {
  const trimmed = raw?.trim().toLowerCase()
  if (!trimmed) return opts.defaults
  if (OFF_VALUES.has(trimmed)) return []
  const out = new Set<HarnessKind>()
  let affirmative = false
  const unrecognized: string[] = []
  for (const token of trimmed.split(',').map((s) => s.trim())) {
    if (token === 'claude-code' || token === 'claude') out.add('claude-code')
    else if (token === 'codex') out.add('codex')
    else if (NATIVE_ALL_VALUES.has(token)) affirmative = true
    else if (token) unrecognized.push(token)
  }
  // No harness named: enable both ONLY for an explicit affirmative keyword; anything else
  // unrecognised stays off (fail-safe — see the doc comment).
  const harnesses = out.size > 0 ? [...out] : affirmative ? BOTH_NATIVE_HARNESSES : []
  // The fail-safe must not be SILENT: a typo (`claudecode`) would otherwise turn the flag off
  // with zero signal and the developer only notices when a run behaves unexpectedly.
  if (unrecognized.length > 0) {
    onWarn?.(
      `${opts.envName}: ignoring unrecognized value(s) '${unrecognized.join("', '")}' ` +
        `(expected claude-code, codex, or an on/off keyword)` +
        (harnesses.length === 0 ? ` — ${opts.offNote}` : ''),
    )
  }
  return harnesses
}

/**
 * Parse `LOCAL_NATIVE_AGENTS` into the set of subscription harnesses to run CONTAINER agents
 * natively (a host process on the developer's own `claude` / `codex` CLI, ambient login,
 * UNSANDBOXED + unmetered). Default OFF (`[]`) — so this opt-in never enables itself, and a
 * typo fails safe rather than dropping the sandbox. See {@link parseHarnessSet}.
 */
export function parseNativeHarnesses(
  raw: string | undefined,
  onWarn?: (message: string) => void,
): HarnessKind[] {
  return parseHarnessSet(
    raw,
    { defaults: [], envName: 'LOCAL_NATIVE_AGENTS', offNote: 'native mode stays OFF' },
    onWarn,
  )
}

/**
 * Parse `LOCAL_NATIVE_INLINE` into the set of subscription harnesses that may serve INLINE LLM
 * steps (requirements reviewer, brainstorm, task-estimator, inline document kinds) via the
 * developer's ambient `claude` / `codex` CLI. Unlike {@link parseNativeHarnesses} this defaults
 * ON (BOTH harnesses when unset): an inline step is a one-shot text call with no repo checkout
 * or tools, so running it on the developer's own CLI is benign, and defaulting on is what lets a
 * subscription-only preset (e.g. everything pinned to `claude-opus`) run its inline reviewers in
 * local / mothership mode without extra setup. Explicit `LOCAL_NATIVE_INLINE=off` disables it.
 */
export function parseInlineHarnesses(
  raw: string | undefined,
  onWarn?: (message: string) => void,
): HarnessKind[] {
  return parseHarnessSet(
    raw,
    {
      defaults: BOTH_NATIVE_HARNESSES,
      envName: 'LOCAL_NATIVE_INLINE',
      offNote: 'inline subscription execution stays OFF',
    },
    onWarn,
  )
}
