import {
  DrizzleAccountRunnerPoolRepository,
  DrizzleRunnerPoolConnectionRepository,
  buildNodeRunnerPoolService,
  runnerPoolResolveTransport,
} from '@cat-factory/node-server'
import type { CoreRepositories, NodeContainerOptions } from '@cat-factory/node-server'
import type { RunnerBackendRegistry } from '@cat-factory/integrations'
import {
  ConflictError,
  type AccountRunnerPoolRepository,
  type Clock,
  type RunnerPoolConnectionRepository,
} from '@cat-factory/kernel'
import type { WorkspaceSettingsService } from '@cat-factory/orchestration'
import { logger } from '@cat-factory/server'
import type { AppConfig, ResolveRunnerTransport } from '@cat-factory/server'
import type { MothershipComposition } from './mothership.js'

// The local facade's self-hosted runner pool: the opt-in target a board delegates its container
// agents to (`delegateAgentsToRunnerPool`), the start-time guard for that opt-in, and the account
// pool a deployment may declare. Split out of `container.ts`, which composes it.

/**
 * The declared account runner pool this node may seed: the deployment's own on the Postgres path,
 * and NONE in mothership mode, where it is dropped with a stated reason. There the account rows
 * belong to the mothership: a seed from this node would seal its secrets with the LAPTOP's
 * `ENCRYPTION_KEY`, a key the mothership cannot open, onto rows every board of the account reads.
 * The mothership's own entry point is where such a seed belongs.
 */
export function localRunnerPoolSeed(
  options: NodeContainerOptions,
  mothership: MothershipComposition | undefined,
): NodeContainerOptions['seedAccountRunnerPool'] {
  if (!mothership) return options.seedAccountRunnerPool
  if (options.seedAccountRunnerPool) {
    logger.warn(
      'local mode: seedAccountRunnerPool is ignored in mothership mode: the account runner pools ' +
        'live on the mothership, and a seed from this node would seal their secrets with this ' +
        'node’s key, which the mothership cannot open. Declare the seed on the mothership’s own ' +
        'entry point.',
    )
  }
  return undefined
}

/**
 * The pool's dispatch resolver (null when the runner-pool integration is off) and the start-time
 * guard. In local mode `runners` is enabled (it keys off ENCRYPTION_KEY, which `applyLocalDefaults`
 * always sets), so a workspace can register a pool via the API; a native adapter injected through
 * `options.runnerPoolProvider` drives the actual dispatch.
 */
export function buildLocalRunnerPoolBackend(params: {
  options: NodeContainerOptions
  mothership: MothershipComposition | undefined
  repos: CoreRepositories
  wsSettings: WorkspaceSettingsService
  config: AppConfig
  clock: Clock
  runnerBackendRegistry: RunnerBackendRegistry
}): {
  poolResolve: ResolveRunnerTransport | null
  assertAgentBackendConfigured: (workspaceId: string) => Promise<void>
} {
  const { options, mothership, repos, wsSettings, config, clock, runnerBackendRegistry } = params
  // In mothership mode there is no local db, so resolve this repo REMOTELY (like the rest of the
  // org state) rather than over an undefined db handle. A delegation check then returns a clean
  // gated `unknown_method` (the repo joins the allow-list in the gating phase, see the tracker)
  // instead of a `Cannot read properties of undefined` TypeError.
  const runnerPoolConnectionRepository: RunnerPoolConnectionRepository = mothership
    ? (
        mothership.repos as unknown as {
          runnerPoolConnectionRepository: RunnerPoolConnectionRepository
        }
      ).runnerPoolConnectionRepository
    : new DrizzleRunnerPoolConnectionRepository(options.db!)
  // The account tier the pool resolver falls back to, resolved the same way (remote in mothership
  // mode). The Postgres path may seed it (`startLocal({ seedAccountRunnerPool })`); mothership mode
  // only reads a row that exists, because the mothership owns that row and its key.
  const accountRunnerPoolRepository: AccountRunnerPoolRepository = mothership
    ? (
        mothership.repos as unknown as {
          accountRunnerPoolRepository: AccountRunnerPoolRepository
        }
      ).accountRunnerPoolRepository
    : new DrizzleAccountRunnerPoolRepository(options.db!)
  // ONE connection service for both readers below: the dispatch resolver and the start-time guard
  // must agree on the board's EFFECTIVE pool (its own row, else its account's), or a board that
  // inherits a declared account pool dispatches fine and is refused at start.
  const poolService = buildNodeRunnerPoolService(
    config,
    runnerPoolConnectionRepository,
    repos.workspaceRepository,
    clock,
    runnerBackendRegistry,
    {
      injectedPoolProvider: options.runnerPoolProvider,
      accountRunnerPool: {
        repository: accountRunnerPoolRepository,
        workspaceSettingsRepository: repos.workspaceSettingsRepository,
      },
    },
  )

  // Start-time guard: refuse a run up front when the workspace delegates agents to a pool
  // that isn't registered, so the human gets a clean 409 (an actionable message) instead of
  // a mid-run dispatch failure. No-op when delegation is off. We throw a ConflictError for
  // BOTH negative cases (the integration being disabled AND no pool registered for the
  // workspace) rather than letting the pool resolver's plain Error escape (the error
  // handler maps a non-DomainError to an opaque 500 with the message suppressed). The
  // existence check is the service's `hasConnection`: the same effective pool dispatch reads
  // (an inherited account pool counts), without decrypting the secrets or building a transport
  // that the actual dispatch resolve would only build again.
  const assertAgentBackendConfigured = async (workspaceId: string): Promise<void> => {
    if (!(await wsSettings.get(workspaceId)).delegateAgentsToRunnerPool) return
    if (!poolService) {
      throw new ConflictError(
        'This workspace delegates container agents to a self-hosted runner pool, but the ' +
          'runner-pool integration is not enabled on this deployment.',
        'agent_backend_unconfigured',
      )
    }
    if (!(await poolService.hasConnection(workspaceId))) {
      throw new ConflictError(
        'This workspace delegates container agents to a self-hosted runner pool, but none ' +
          'is registered. Register one (Settings → Self-hosted runner pool) or turn ' +
          'delegation off to run agents on host Docker, before starting.',
        'agent_backend_unconfigured',
      )
    }
  }

  return { poolResolve: runnerPoolResolveTransport(poolService), assertAgentBackendConfigured }
}
