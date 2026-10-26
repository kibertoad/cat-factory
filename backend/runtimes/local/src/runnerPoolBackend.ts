import {
  DrizzleAccountRunnerPoolRepository,
  DrizzleRunnerPoolConnectionRepository,
  buildNodeRunnerPoolService,
  runnerPoolResolveTransport,
} from '@cat-factory/node-server'
import type { CoreRepositories, NodeContainerOptions } from '@cat-factory/node-server'
import type { RunnerBackendRegistry, RunnerPoolReadiness } from '@cat-factory/integrations'
import {
  ConflictError,
  type Clock,
  type Logger,
  type RunnerPoolConnectionRepository,
} from '@cat-factory/kernel'
import type { WorkspaceSettingsService } from '@cat-factory/orchestration'
import type { AppConfig, ResolveRunnerTransport } from '@cat-factory/server'
import type { MothershipComposition } from './mothership.js'

// The local facade's self-hosted runner pool: the opt-in target a board delegates its container
// agents to (`delegateAgentsToRunnerPool`), the start-time guard for that opt-in, and the account
// pool a deployment may declare. Split out of `container.ts`, which composes it.

/**
 * Why an account pool never reaches a mothership node. A node opens a pool's sealed secrets with its
 * OWN `ENCRYPTION_KEY`, and the account rows live on the mothership, sealed with the mothership's
 * key. So the node neither seeds them nor reads them: a board there runs on the pool registered for
 * that board from the node, or on host containers.
 */
const MOTHERSHIP_ACCOUNT_POOL_NOTE =
  'An account runner pool does not reach a node in mothership mode: the node opens pool secrets ' +
  'with its own key, and account pools are sealed on the mothership. Register the pool on the ' +
  'board from this node instead.'

/**
 * The declared account runner pool this node may seed: the deployment's own on the Postgres path,
 * and NONE in mothership mode, where it is dropped with {@link MOTHERSHIP_ACCOUNT_POOL_NOTE}.
 */
export function localRunnerPoolSeed(
  options: NodeContainerOptions,
  mothership: MothershipComposition | undefined,
  log: Logger,
): NodeContainerOptions['seedAccountRunnerPool'] {
  if (!mothership) return options.seedAccountRunnerPool
  if (options.seedAccountRunnerPool) {
    log.warn(
      `local mode: seedAccountRunnerPool is ignored in mothership mode. ${MOTHERSHIP_ACCOUNT_POOL_NOTE}`,
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
  // In mothership mode there is no local db, so the board's own row is read remotely.
  const runnerPoolConnectionRepository: RunnerPoolConnectionRepository = mothership
    ? (
        mothership.repos as unknown as {
          runnerPoolConnectionRepository: RunnerPoolConnectionRepository
        }
      ).runnerPoolConnectionRepository
    : new DrizzleRunnerPoolConnectionRepository(options.db!)
  // The dispatch resolver and the start-time guard read the board's EFFECTIVE pool through this one
  // service: its own row, else (on the Postgres path only) its account's row.
  const poolService = buildNodeRunnerPoolService(
    config,
    runnerPoolConnectionRepository,
    repos.workspaceRepository,
    clock,
    runnerBackendRegistry,
    {
      injectedPoolProvider: options.runnerPoolProvider,
      ...(mothership
        ? {}
        : {
            accountRunnerPool: {
              repository: new DrizzleAccountRunnerPoolRepository(options.db!),
              workspaceSettingsRepository: repos.workspaceSettingsRepository,
            },
          }),
    },
  )

  // Start-time guard: refuse a delegating run up front with a 409 naming what to fix, instead of a
  // mid-run dispatch failure (the resolver's own throw reaches the error handler as an opaque 500).
  // No-op when delegation is off. `dispatchReadiness` answers what `resolve` would, without
  // decrypting the secrets or building a transport that dispatch would only build again.
  const assertAgentBackendConfigured = async (workspaceId: string): Promise<void> => {
    if (!(await wsSettings.get(workspaceId)).delegateAgentsToRunnerPool) return
    if (!poolService) {
      throw delegationRefused(
        'the runner-pool integration is not enabled on this deployment.',
        'integration_off',
      )
    }
    const readiness = await poolService.dispatchReadiness(workspaceId)
    if (readiness.state !== 'ready') throw refusalFor(readiness, mothership !== undefined)
  }

  return { poolResolve: runnerPoolResolveTransport(poolService), assertAgentBackendConfigured }
}

/** The cause a refused delegating run carries in `details.runnerPool`, one per distinct fix. */
type DelegationRefusalCause = 'integration_off' | Exclude<RunnerPoolReadiness['state'], 'ready'>

function refusalFor(
  readiness: Exclude<RunnerPoolReadiness, { state: 'ready' }>,
  onMothershipNode: boolean,
): ConflictError {
  switch (readiness.state) {
    case 'inheritance_off':
      return delegationRefused(
        'it has opted out of its account’s runner pool. Set the workspace setting ' +
          '`inheritAccountRunnerPool` back to true, register a pool for this workspace, or turn ' +
          'delegation off to run agents on host Docker, before starting.',
        readiness.state,
      )
    case 'unknown_kind':
      return delegationRefused(
        `its runner pool uses the backend kind '${readiness.kind}', which this deployment does ` +
          'not register. Register that kind, replace the pool (Settings → Self-hosted runner ' +
          'pool), or turn delegation off to run agents on host Docker, before starting.',
        readiness.state,
        { kind: readiness.kind },
      )
    case 'none':
      return delegationRefused(
        'none is registered. Register one (Settings → Self-hosted runner pool) or turn ' +
          'delegation off to run agents on host Docker, before starting.' +
          (onMothershipNode ? ` ${MOTHERSHIP_ACCOUNT_POOL_NOTE}` : ''),
        readiness.state,
      )
  }
}

function delegationRefused(
  why: string,
  cause: DelegationRefusalCause,
  extra: Record<string, unknown> = {},
): ConflictError {
  return new ConflictError(
    `This workspace delegates container agents to a self-hosted runner pool, but ${why}`,
    'agent_backend_unconfigured',
    { runnerPool: cause, ...extra },
  )
}
