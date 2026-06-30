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
import type { NodeContainerOptions } from '@cat-factory/node-server'
import {
  SqliteWorkRunner,
  type MothershipComposition,
  composeMothership,
  isMothershipMode,
} from './mothership.js'
import { ConflictError } from '@cat-factory/kernel'
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
import { buildLocalDeployTransport } from './NativeCliDeployTransport.js'
import { applyLocalDefaults } from './config.js'
import {
  buildVcsIdentityRegistry,
  createLocalGitHubClient,
  createLocalGitLabClient,
  fetchPatAccount,
  githubPatCreationUrl,
  gitlabPatCreationUrl,
  gitlabVcsHost,
} from './github.js'
import type { GitHubClient } from '@cat-factory/kernel'
import type { ResolveRepoOrigin } from '@cat-factory/server'
import { AutoProvisioningInstallationRepository, type PatAccount } from './installations.js'
import {
  type LocalContainerRunnerTransport,
  createLocalContainerTransportFromEnv,
} from './LocalContainerRunnerTransport.js'
import {
  type LocalProcessRunnerTransport,
  createLocalProcessTransportFromEnv,
} from './LocalProcessRunnerTransport.js'
import { createRuntimeAdapter, resolveRuntimeId, runtimeProfile } from './runtimes/index.js'
import { createDockerComposeRuntime } from './compose.js'

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

export function buildLocalContainer(options: NodeContainerOptions): ServerContainer {
  const env = applyLocalDefaults(options.env ?? process.env)
  // Mothership mode (docs/initiatives/mothership-mode.md): no local Postgres. Org/durable
  // state is served remotely (RPC) and credentials stay local (node:sqlite). When on, we
  // build the composite repositories + credential store here and thread them through the
  // existing NodeContainer seams with `db` left undefined; the in-process work runner replaces
  // pg-boss. Off → the standard siloed-Postgres local mode is unchanged.
  const mothership: MothershipComposition | undefined =
    isMothershipMode(env) && !options.db ? composeMothership(env) : undefined
  const pat = env.GITHUB_PAT?.trim()
  const gitlabPat = env.GITLAB_PAT?.trim()
  // The push/clone token and the VCS client are provider-agnostic. Prefer a GitHub PAT, else
  // fall back to a GitLab PAT, so a GitLab-only local deployment still (a) authenticates the
  // agent containers' git clone/push — the harness uses a host-neutral GIT_ASKPASS credential,
  // so the same token drives github.com or gitlab.com — and (b) gates on CI + merges through
  // the GitLab API via the VcsClient→GitHubClient adapter. `gitToken` is what the harness
  // pushes with; `vcsClient` is what the gates/merger/repo-link read through.
  const gitToken = pat ?? gitlabPat
  const vcsClient: GitHubClient | undefined = pat
    ? createLocalGitHubClient(env)
    : gitlabPat
      ? createLocalGitLabClient(env)
      : undefined
  // When GitLab is the active backend (no GitHub PAT), the agent containers must clone the
  // GitLab host and open merge requests — not github.com. The repo projection carries no host,
  // so build the clone URL + provider from the configured GitLab host here. Same host the
  // harness allow-list is widened to (`harnessAllowedHosts`), so they can't disagree.
  const gitlabHost = pat ? undefined : gitlabPat ? gitlabVcsHost(env) : undefined
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
  const nativeHarnesses = parseNativeHarnesses(env.LOCAL_NATIVE_AGENTS)
  const nativeAgents = nativeHarnesses.length > 0
  // The source-control PAT-login registry (GitHub + GitLab), assembled provider-agnostically
  // from env. `configured` providers (their PAT is set in env) offer a "Sign in with configured
  // <provider> PAT" button — the only sign-in path, since that env token is also the operational
  // credential. Advertised on `localMode.patLogin` so the login screen renders the right
  // buttons, and exposed on the container for the `/auth/pat` endpoint.
  const { registry: vcsIdentity, configured } = buildVcsIdentityRegistry(env)
  const config: AppConfig = {
    ...base,
    // Enable the (provider-neutral) source-control integration for EITHER PAT: the read/link
    // endpoints + gates are served through `vcsClient`, GitHub- or GitLab-backed alike.
    ...(gitToken ? { github: { ...base.github, enabled: true } } : {}),
    ...(nativeAgents ? { nativeAmbientAuth: nativeHarnesses } : {}),
    localMode: {
      enabled: true,
      // Surfaced to the SPA so it can label what is stored locally (credentials) vs delegated
      // to the mothership (org/durable state). Off → the standard siloed-Postgres local mode.
      ...(mothership ? { mothership: true } : {}),
      ...(gitToken ? {} : { githubPatSetupUrl: githubPatCreationUrl() }),
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
        )
      : undefined

  // One shared persistence set + clock/idGenerator, reused by the per-workspace transport
  // chooser below AND threaded into `buildNodeContainer` (which would otherwise build its
  // own) so the chooser reads the same workspace settings the rest of the engine does.
  const clock = new SystemClock()
  const idGenerator = new CryptoIdGenerator()
  // In mothership mode the repository set is the remote (RPC-backed) composite; otherwise the
  // Drizzle set over the local Postgres. The credential repos are injected separately below.
  const repos =
    options.repos ??
    mothership?.repos ??
    createDrizzleRepositories(options.db as Parameters<typeof createDrizzleRepositories>[0], clock)
  const wsSettings = new WorkspaceSettingsService({
    workspaceSettingsRepository: repos.workspaceSettingsRepository,
    workspaceRepository: repos.workspaceRepository,
  })

  // The local container transport is constructed LAZILY on first dispatch, so the service
  // still boots to serve the board (and inline kinds) when LOCAL_HARNESS_IMAGE is unset —
  // only repo-operating container kinds then fail, loudly and with a clear message,
  // mirroring how the Node facade treats a missing runner backend.
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

  const localSettingsService = options.db
    ? new LocalSettingsService({
        localSettingsRepository: new DrizzleLocalSettingsRepository(options.db),
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
  const localAgentsResolve: ResolveRunnerTransport = () => {
    if (nativeAgents) {
      if (!routed) {
        let proc: LocalProcessRunnerTransport | undefined
        routed = new NativeRoutingRunnerTransport(
          () => (proc ??= createLocalProcessTransportFromEnv(env)),
          resolveContainerTransport,
        )
      }
      return Promise.resolve(routed)
    }
    return resolveContainerTransport()
  }

  // Eagerly kick off the serving transport's boot housekeeping (reap + pre-warm) when an
  // image is configured, so a warm pool is ready before the first run rather than warming
  // on first dispatch. Skipped without an image (the board still boots; only container
  // kinds fail, loudly). Fire-and-forget: dispatch reuses the same cached promise.
  if (env.LOCAL_HARNESS_IMAGE?.trim()) void resolveContainerTransport().catch(() => {})

  // The DEPLOY job client (the async container-backed Kubernetes render lifecycle). Local runs
  // it on a DEDICATED deploy backend — the developer's host `kubectl`/`kustomize`/`helm` (native
  // mode) or a per-job deploy-harness container — NOT the agent transport (which runs the
  // executor-harness image, lacking the k8s CLIs). When `LOCAL_DEPLOY_RUNTIME`'s prerequisite
  // isn't configured this is null, so deploy stays UNWIRED (a render-needing config fails loudly;
  // the raw-manifest REST path is unaffected) — never silently routed to the agent backend (the
  // `disableDefaultDeployJobClient` flag below stops `buildNodeContainer` falling back). The
  // clone target is inherited from `buildNodeContainer`'s default, which already uses local's PAT
  // mint + GitLab-aware `resolveRepoOrigin`.
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
  if (
    runtimeProfile(localRuntimeId).family === 'docker' &&
    !backendRegistries.environmentBackendRegistry.get('compose')
  ) {
    const composeBinary = env.LOCAL_DOCKER_BINARY?.trim() || runtimeProfile(localRuntimeId).binary
    backendRegistries.environmentBackendRegistry.register(
      composeEnvironmentBackend(createDockerComposeRuntime({ binary: composeBinary })),
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
      // Prefill the image of a low-config k3s runner preset — local mode knows its harness ref.
      suggestedExecutorImage: env.LOCAL_HARNESS_IMAGE?.trim() || undefined,
    },
    testEnv: {
      available: localTestInfraSupported
        ? ['local-compose', 'environment-provider']
        : ['environment-provider'],
      active: localTestInfraSupported ? 'local-compose' : 'environment-provider',
    },
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
    // Mothership credentials stay on the laptop: inject the local node:sqlite store's two repos
    // so the API-key pool + local-model endpoints are sealed with the LOCAL key (the
    // mothership's ENCRYPTION_KEY never reaches this machine). Off → Drizzle over Postgres.
    ...(mothership
      ? {
          providerApiKeyRepository: mothership.credentialStore.providerApiKeyRepository,
          localModelEndpointRepository: mothership.credentialStore.localModelEndpointRepository,
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
    // credential is host-neutral). Absent → the executor falls back to the GitHub App path
    // (and is null without it), so container kinds fail loudly rather than silently mis-running.
    ...(gitToken ? { mintInstallationToken: async () => gitToken } : {}),
    // The PAT-backed VCS client wires the CI gate + merge / mergeability providers, so a local
    // pipeline gates on real CI and merges the PR/MR for real, AND serves the read/link
    // endpoints. GitHub uses the PAT client (repos via /user/repos); GitLab uses the
    // FetchGitLabClient adapted to the same GitHubClient port.
    ...(vcsClient ? { githubClient: vcsClient } : {}),
    // For a GitLab backend, make agent containers clone the GitLab host + open MRs (without
    // this the clone URL is always github.com, so a GitLab repo can't be cloned).
    ...(resolveRepoOrigin ? { resolveRepoOrigin } : {}),
    // Auto-provision the synthetic per-workspace installation so the integration reports
    // connected with no manual connect step.
    ...(githubInstallationRepository ? { githubInstallationRepository } : {}),
    overrides: {
      // Refuse a run up front when the workspace delegates container agents to a runner pool
      // that isn't registered. Listed BEFORE `...options.overrides` so a caller (the
      // cross-runtime conformance harness) can override it.
      assertAgentBackendConfigured,
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
      // Gate the Tester's local-infra mode on the runtime's Docker-in-Docker support
      // (local-authoritative — after the overrides so a deployment can't accidentally
      // claim DinD support the runtime doesn't have).
      localTestInfraSupported,
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
  // `signalDecision` drive runs in-process (mothership mode; no-op otherwise).
  inProcessRunner?.bind(container.executionService)

  // Surface the local-mode settings service so the dedicated local-settings panel can
  // read/write the warm-pool + checkout config (the controller 503s when this is absent,
  // which is the case on every non-local facade). Also expose the PAT-login registry so the
  // `/auth/pat` endpoint can resolve a GitHub/GitLab identity (local-mode only).
  return {
    ...container,
    vcsIdentity,
    ...(localSettingsService ? { localSettings: { service: localSettingsService } } : {}),
    // On shutdown (mothership mode; the boot path calls this from its SIGTERM/SIGINT handler):
    // stop the work runner's recovery poll FIRST so it can't touch the queue mid-close, then
    // release both local SQLite handles (credentials + work queue). No-op otherwise.
    ...(mothership
      ? {
          onShutdown: () => {
            inProcessRunner?.stop()
            mothership.close()
          },
        }
      : {}),
  }
}

/** Values that explicitly DISABLE native mode (so `LOCAL_NATIVE_AGENTS=false` means off). */
const NATIVE_OFF_VALUES = new Set(['false', '0', 'off', 'no', 'none', 'disabled'])
/** Affirmative values that enable BOTH native harnesses without naming one. */
const NATIVE_ALL_VALUES = new Set(['true', '1', 'on', 'yes', 'all', 'both'])

/**
 * Parse `LOCAL_NATIVE_AGENTS` into the set of subscription harnesses to run natively. The
 * documented form is a comma-separated list of harness ids (`claude-code,codex`); `claude`
 * is accepted as an alias for `claude-code`. Blank/unset OR an explicit off value
 * (`false`/`0`/`off`/`no`/`none`/`disabled`) ⇒ off (`[]`) — so disabling native mode never
 * accidentally enables it. An affirmative value naming no harness (`true`/`1`/`on`/…) ⇒ BOTH
 * native harnesses. Only `claude-code` / `codex` are ever native; any other unrecognised
 * token is ignored. A value with neither a recognised harness nor an affirmative keyword
 * (e.g. a typo) ⇒ off, so an unintelligible setting fails safe rather than enabling an
 * unsandboxed, unmetered mode.
 */
export function parseNativeHarnesses(raw: string | undefined): HarnessKind[] {
  const trimmed = raw?.trim().toLowerCase()
  if (!trimmed || NATIVE_OFF_VALUES.has(trimmed)) return []
  const out = new Set<HarnessKind>()
  let affirmative = false
  for (const token of trimmed.split(',').map((s) => s.trim())) {
    if (token === 'claude-code' || token === 'claude') out.add('claude-code')
    else if (token === 'codex') out.add('codex')
    else if (NATIVE_ALL_VALUES.has(token)) affirmative = true
  }
  if (out.size > 0) return [...out]
  // No harness named: enable both ONLY for an explicit affirmative keyword; anything else
  // unrecognised stays off (fail-safe — see the doc comment).
  return affirmative ? ['claude-code', 'codex'] : []
}
