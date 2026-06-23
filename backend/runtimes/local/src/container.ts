import {
  DrizzleGitHubInstallationRepository,
  buildNodeContainer,
  loadNodeConfig,
} from '@cat-factory/node-server'
import type { NodeContainerOptions } from '@cat-factory/node-server'
import type { AppConfig, ResolveRunnerTransport, ServerContainer } from '@cat-factory/server'
import type { CoreDependencies } from '@cat-factory/orchestration'
import { applyLocalDefaults } from './config.js'
import { createLocalGitHubClient, fetchPatAccount, githubPatCreationUrl } from './github.js'
import { AutoProvisioningInstallationRepository, type PatAccount } from './installations.js'
import {
  type LocalDockerRunnerTransport,
  createLocalDockerTransportFromEnv,
} from './LocalDockerRunnerTransport.js'

// The local-mode composition root. It is intentionally thin: the ENTIRE Drizzle/
// Postgres persistence, pg-boss durable execution, gateways and model provisioning
// come from `buildNodeContainer` unchanged. Local mode only swaps the two
// differentiators behind the seams `buildNodeContainer` exposes:
//   - the runner backend → a per-job local Docker container (LocalDockerRunnerTransport)
//     instead of a self-hosted runner pool;
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

  // The Docker transport is constructed LAZILY on first container-job dispatch, so the
  // service still boots to serve the board (and inline kinds) when LOCAL_HARNESS_IMAGE
  // is unset — only repo-operating kinds then fail, loudly and with a clear message,
  // mirroring how the Node facade treats a missing runner backend.
  let transport: LocalDockerRunnerTransport | undefined
  const resolveTransport: ResolveRunnerTransport = () => {
    transport ??= createLocalDockerTransportFromEnv(env)
    return Promise.resolve(transport)
  }

  return buildNodeContainer({
    ...options,
    env,
    config,
    // Always dispatch container jobs to the local Docker transport (a constant
    // resolver, ignoring workspace — local mode has no per-workspace runner pools).
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
    },
  })
}
