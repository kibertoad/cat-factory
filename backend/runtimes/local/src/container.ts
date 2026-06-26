import {
  DrizzleGitHubInstallationRepository,
  buildNodeContainer,
  loadNodeConfig,
} from '@cat-factory/node-server'
import type { NodeContainerOptions } from '@cat-factory/node-server'
import type { AppConfig, ResolveRunnerTransport, ServerContainer } from '@cat-factory/server'
import type { CoreDependencies } from '@cat-factory/orchestration'
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
// come from `buildNodeContainer` unchanged. Local mode only swaps the two
// differentiators behind the seams `buildNodeContainer` exposes:
//   - the runner backend → a per-run local container (LocalContainerRunnerTransport,
//     Docker/Podman/OrbStack/Colima/Apple `container`) instead of a self-hosted pool;
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

  // The runner transport(s) are constructed LAZILY on first dispatch, so the service still
  // boots to serve the board (and inline kinds) when LOCAL_HARNESS_IMAGE is unset — only
  // repo-operating container kinds then fail, loudly and with a clear message, mirroring how
  // the Node facade treats a missing runner backend.
  //
  // Native mode does NOT blanket-route every dispatch to the host process: a host process
  // has no sandbox, so only the steps that actually use the developer's ambient CLI login
  // (flagged `ambientAuth` by the executor) run there. Everything else — a proxy/`pi` model,
  // or a non-native vendor reusing the claude-code harness — still runs in a per-run
  // container (built lazily, so a Claude/Codex-only native deployment never needs an image;
  // a proxy step without one fails loudly there). See NativeRoutingRunnerTransport.
  let container: LocalContainerRunnerTransport | undefined
  const resolveContainerTransport = () => (container ??= createLocalContainerTransportFromEnv(env))
  let routed: RunnerTransport | undefined
  const resolveTransport: ResolveRunnerTransport = () => {
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
    return Promise.resolve(resolveContainerTransport())
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

  return buildNodeContainer({
    ...options,
    env,
    config,
    // Dispatch container jobs to the local Docker transport (ignoring workspace — local
    // mode has no per-workspace runner pools), or, in native mode, to the per-job router
    // that sends only ambient-CLI steps to the host process and the rest to a container.
    resolveTransport,
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
      ...options.overrides,
      // The local PAT carries `workflow` scope (the creation URL pre-selects it), so the
      // connection isn't missing workflows: write — report it granted to suppress the
      // advisory banner. (The App-permissions probe this normally uses needs an app JWT.)
      ...(pat ? ({ workflowsGranted: async () => true } satisfies Partial<CoreDependencies>) : {}),
      // Gate the Tester's local-infra mode on the runtime's Docker-in-Docker support.
      localTestInfraSupported,
    } satisfies Partial<CoreDependencies>,
  })
}

/**
 * Parse `LOCAL_NATIVE_AGENTS` into the set of subscription harnesses to run natively. The
 * documented form is a comma-separated list of harness ids (`claude-code,codex`); `claude`
 * is accepted as an alias for `claude-code`. A set-but-unrecognised value (e.g. a bare
 * `true` / `1`) is treated as "enable both native harnesses" so turning native mode on is
 * forgiving; blank/unset ⇒ off (`[]`). Only `claude-code` / `codex` are ever native.
 */
function parseNativeHarnesses(raw: string | undefined): HarnessKind[] {
  const trimmed = raw?.trim()
  if (!trimmed) return []
  const out = new Set<HarnessKind>()
  for (const token of trimmed.split(',').map((s) => s.trim().toLowerCase())) {
    if (token === 'claude-code' || token === 'claude') out.add('claude-code')
    else if (token === 'codex') out.add('codex')
  }
  // Non-empty but nothing recognised → the operator clearly meant "on"; enable both.
  if (out.size === 0) return ['claude-code', 'codex']
  return [...out]
}
