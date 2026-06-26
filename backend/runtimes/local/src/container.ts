import {
  CryptoIdGenerator,
  DrizzleGitHubInstallationRepository,
  DrizzleLocalSettingsRepository,
  DrizzleRunnerPoolConnectionRepository,
  ProvisioningLogRecorder,
  SystemClock,
  buildNodeContainer,
  buildNodeResolveTransport,
  createDrizzleRepositories,
  loadNodeConfig,
  withProvisioningLog,
} from '@cat-factory/node-server'
import type { NodeContainerOptions } from '@cat-factory/node-server'
import { ConflictError } from '@cat-factory/kernel'
import { WorkspaceSettingsService } from '@cat-factory/orchestration'
import { logger } from '@cat-factory/server'
import type { AppConfig, ResolveRunnerTransport, ServerContainer } from '@cat-factory/server'
import type { CoreDependencies } from '@cat-factory/orchestration'
import { LocalSettingsService } from '@cat-factory/integrations'
import type { HarnessKind, RunnerTransport } from '@cat-factory/kernel'
import { NativeRoutingRunnerTransport } from './NativeRoutingRunnerTransport.js'
import { applyLocalDefaults } from './config.js'
import { createLocalGitHubClient, fetchPatAccount, githubPatCreationUrl } from './github.js'
import { AutoProvisioningInstallationRepository, type PatAccount } from './installations.js'
import {
  type LocalContainerRunnerTransport,
  createLocalContainerTransportFromEnv,
} from './LocalContainerRunnerTransport.js'
import {
  type LocalProcessRunnerTransport,
  createLocalProcessTransportFromEnv,
} from './LocalProcessRunnerTransport.js'
import { createRuntimeAdapter } from './runtimes/index.js'

// The local-mode composition root. It is intentionally thin: the ENTIRE Drizzle/
// Postgres persistence, pg-boss durable execution, gateways and model provisioning
// come from `buildNodeContainer` unchanged. Local mode only swaps the differentiators
// behind the seams `buildNodeContainer` exposes:
//   - the runner backend → host Docker by default (a per-run local container,
//     LocalContainerRunnerTransport, Docker/Podman/OrbStack/Colima/Apple `container`,
//     with the warm pool + per-repo checkout reuse configured from the DB local-mode
//     settings), but PER WORKSPACE it can be delegated to the workspace's registered
//     self-hosted runner pool (the `delegateAgentsToRunnerPool` setting) — the
//     local-vs-external opt-in. The Tester's environment is the symmetric opt-in
//     (`delegateTestEnvToProvider`, wired below as the tester fallback default), so a
//     developer runs everything locally by default but can flip either concern to an
//     external service from the UI;
//   - optional NATIVE execution: run agents as a host process driving the developer's own
//     installed `claude` / `codex` CLI (ambient login), bypassing Docker for the steps that
//     use that login (`LOCAL_NATIVE_AGENTS`); everything else still runs in a container;
//   - the push/clone token → a static GitHub PAT (`GITHUB_PAT`) instead of a GitHub
//     App installation token.
// Repo resolution is unchanged: the executor still resolves a block's repo from the
// `github_repos` / `github_installations` projection (seed those rows for a target
// repo with the link helper). So a developer can run coder/mocker/playwright/
// blueprints/ci-fixer/merger jobs entirely locally, pushing real branches and opening
// real PRs on github.com via the PAT.

export function buildLocalContainer(options: NodeContainerOptions): ServerContainer {
  const env = applyLocalDefaults(options.env ?? process.env)
  const pat = env.GITHUB_PAT?.trim()
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
  const config: AppConfig = {
    ...base,
    ...(pat ? { github: { ...base.github, enabled: true } } : {}),
    ...(nativeAgents ? { nativeAmbientAuth: nativeHarnesses } : {}),
    localMode: {
      enabled: true,
      ...(pat ? {} : { githubPatSetupUrl: githubPatCreationUrl() }),
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
    pat && options.db
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
  const repos = options.repos ?? createDrizzleRepositories(options.db, clock)
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

  // The runner-pool resolver (the external opt-in target). In local mode `runners` is
  // enabled (it keys off ENCRYPTION_KEY, which `applyLocalDefaults` always sets), so this
  // is non-null and a workspace can register a pool via the API; a native adapter injected
  // through `options.runnerPoolProvider` drives the actual dispatch. The connection repo is
  // also held for the start-time guard's cheap "is a pool registered?" existence check.
  const runnerPoolConnectionRepository = new DrizzleRunnerPoolConnectionRepository(options.db)
  const poolResolve = buildNodeResolveTransport(
    config,
    runnerPoolConnectionRepository,
    repos.workspaceRepository,
    clock,
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

  // The two tester-environment resolvers (used identically by the start gate and the
  // agent-context materialisation): the local-mode default is `local` (host Docker / DinD),
  // flipping to `ephemeral` only when the workspace opts into its environment provider; and
  // when it opts in, the provider becomes REQUIRED so an `ephemeral` run with none connected
  // is refused at start.
  const resolveTesterFallbackDefault = async (
    workspaceId: string,
  ): Promise<'local' | 'ephemeral'> =>
    (await wsSettings.get(workspaceId)).delegateTestEnvToProvider ? 'ephemeral' : 'local'
  const resolveRequireEnvironmentProvider = async (workspaceId: string): Promise<boolean> =>
    (await wsSettings.get(workspaceId)).delegateTestEnvToProvider

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

  const container = buildNodeContainer({
    ...options,
    env,
    config,
    repos,
    // The per-workspace chooser (host Docker / native local vs the runner pool). Pre-wrapped
    // with the correct provisioning-log subsystem per branch, so tell buildNodeContainer not
    // to re-wrap with a single subsystem tag.
    resolveTransport,
    skipProvisioningLogWrap: true,
    // Authenticate git with the developer's PAT when present. Absent → the executor
    // falls back to the GitHub App path (and is null without it), so container kinds
    // fail loudly rather than silently mis-running.
    ...(pat ? { mintInstallationToken: async () => pat } : {}),
    // The PAT-backed GitHub client wires the CI gate + merge / mergeability providers,
    // so a local pipeline gates on real GitHub Actions CI and merges the PR for real, AND
    // serves the read/link endpoints (it lists repos via /user/repos, the PAT analogue of
    // the App-only /installation/repositories).
    ...(pat ? { githubClient: createLocalGitHubClient(env) } : {}),
    // Auto-provision the synthetic per-workspace installation so the integration reports
    // connected with no manual connect step.
    ...(githubInstallationRepository ? { githubInstallationRepository } : {}),
    overrides: {
      // The local-mode infrastructure-delegation opt-ins (per workspace). Listed BEFORE
      // `...options.overrides` so a caller (the cross-runtime conformance harness) can pin
      // the facade-NEUTRAL `ephemeral` tester default for the shared assertions — the local
      // `local` default is a facade-specific behavior covered by its own tests.
      resolveTesterFallbackDefault,
      resolveRequireEnvironmentProvider,
      assertAgentBackendConfigured,
      ...options.overrides,
      // The local PAT carries `workflow` scope (the creation URL pre-selects it), so the
      // connection isn't missing workflows: write — report it granted to suppress the
      // advisory banner. (The App-permissions probe this normally uses needs an app JWT.)
      ...(pat ? ({ workflowsGranted: async () => true } satisfies Partial<CoreDependencies>) : {}),
      // Gate the Tester's local-infra mode on the runtime's Docker-in-Docker support
      // (local-authoritative — after the overrides so a deployment can't accidentally
      // claim DinD support the runtime doesn't have).
      localTestInfraSupported,
    } satisfies Partial<CoreDependencies>,
  })

  // Surface the local-mode settings service so the dedicated local-settings panel can
  // read/write the warm-pool + checkout config (the controller 503s when this is absent,
  // which is the case on every non-local facade).
  return localSettingsService
    ? { ...container, localSettings: { service: localSettingsService } }
    : container
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
