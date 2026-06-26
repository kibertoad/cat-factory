import {
  CryptoIdGenerator,
  DrizzleGitHubInstallationRepository,
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
import type { AppConfig, ResolveRunnerTransport, ServerContainer } from '@cat-factory/server'
import type { CoreDependencies } from '@cat-factory/orchestration'
import { applyLocalDefaults } from './config.js'
import { createLocalGitHubClient, fetchPatAccount, githubPatCreationUrl } from './github.js'
import { AutoProvisioningInstallationRepository, type PatAccount } from './installations.js'
import {
  type LocalContainerRunnerTransport,
  createLocalContainerTransportFromEnv,
} from './LocalContainerRunnerTransport.js'
import { createRuntimeAdapter } from './runtimes/index.js'

// The local-mode composition root. It is intentionally thin: the ENTIRE Drizzle/
// Postgres persistence, pg-boss durable execution, gateways and model provisioning
// come from `buildNodeContainer` unchanged. Local mode only swaps the differentiators
// behind the seams `buildNodeContainer` exposes:
//   - the runner backend → host Docker by default (a per-run local container,
//     LocalContainerRunnerTransport, Docker/Podman/OrbStack/Colima/Apple `container`),
//     but PER WORKSPACE it can be delegated to the workspace's registered self-hosted
//     runner pool (the `delegateAgentsToRunnerPool` setting) — the local-vs-external
//     opt-in. The Tester's environment is the symmetric opt-in (`delegateTestEnvToProvider`,
//     wired below as the tester fallback default), so a developer runs everything locally
//     by default but can flip either concern to an external service from the UI;
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
  const config: AppConfig = {
    ...base,
    ...(pat ? { github: { ...base.github, enabled: true } } : {}),
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

  // The Docker transport is constructed LAZILY on first container-job dispatch, so the
  // service still boots to serve the board (and inline kinds) when LOCAL_HARNESS_IMAGE
  // is unset — only repo-operating kinds then fail, loudly and with a clear message,
  // mirroring how the Node facade treats a missing runner backend.
  let transport: LocalContainerRunnerTransport | undefined
  const localResolve: ResolveRunnerTransport = () => {
    transport ??= createLocalContainerTransportFromEnv(env)
    return Promise.resolve(transport)
  }
  // The runner-pool resolver (the external opt-in target). In local mode `runners` is
  // enabled (it keys off ENCRYPTION_KEY, which `applyLocalDefaults` always sets), so this
  // is non-null and a workspace can register a pool via the API; a native adapter injected
  // through `options.runnerPoolProvider` drives the actual dispatch. Its own throw is the
  // clean "register a pool" error when delegation is on but no pool is registered.
  const poolResolve = buildNodeResolveTransport(
    config,
    new DrizzleRunnerPoolConnectionRepository(options.db),
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
  const wrappedLocal = withProvisioningLog(localResolve, recorder, 'container')!
  const wrappedPool = poolResolve ? withProvisioningLog(poolResolve, recorder, 'runner-pool') : null

  // The local-vs-external agents opt-in: dispatch to the registered runner pool when the
  // workspace opts in (and one is wrapped), else to host Docker. The pool branch's own
  // throw surfaces a clean "register a pool" message when delegation is on but none exists.
  const resolveTransport: ResolveRunnerTransport = async (workspaceId) => {
    const delegate = !!workspaceId && (await wsSettings.get(workspaceId)).delegateAgentsToRunnerPool
    if (delegate && wrappedPool) return wrappedPool(workspaceId)
    return wrappedLocal(workspaceId)
  }

  // Start-time guard: refuse a run up front when the workspace delegates agents to a pool
  // that isn't registered, so the human gets a clean 409 instead of a mid-run dispatch
  // failure. No-op when delegation is off.
  const assertAgentBackendConfigured = async (workspaceId: string): Promise<void> => {
    if (!(await wsSettings.get(workspaceId)).delegateAgentsToRunnerPool) return
    if (!wrappedPool) {
      throw new ConflictError(
        'This workspace delegates container agents to a self-hosted runner pool, but the ' +
          'runner-pool integration is not enabled on this deployment.',
        'agent_backend_unconfigured',
      )
    }
    // The pool resolver throws the clean "register one (POST /workspaces/:id/runner-pools)"
    // message when no pool is registered for the workspace.
    await wrappedPool(workspaceId)
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
  const localTestInfraSupported = createRuntimeAdapter(env).capabilities.localDind

  return buildNodeContainer({
    ...options,
    env,
    config,
    repos,
    // The per-workspace chooser (host Docker vs the runner pool). Pre-wrapped with the
    // correct provisioning-log subsystem per branch, so tell buildNodeContainer not to
    // re-wrap with a single subsystem tag.
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
}
