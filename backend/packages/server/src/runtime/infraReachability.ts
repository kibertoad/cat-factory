import { INFRA_SETUP_PROBED_AREAS, type InfraSetupArea } from '@cat-factory/contracts'
import {
  type ConnectionTestResult,
  decideReachability,
  describeError,
  type InfraSetupTransition,
  type Logger,
  type ProbeOutcome,
  recordedUnreachableAreas,
  redactSecrets,
  runBestEffort,
} from '@cat-factory/kernel'
import type { ServerContainer } from '../http/env.js'

// Runtime-neutral infrastructure-REACHABILITY watcher — shared by both facades' periodic sweeps
// (the Worker's cron `scheduled` handler and the Node `setInterval` sweeper), exactly like
// `sweepPlatformHealth`. For every workspace whose infrastructure connections are CONFIGURED, it
// probes the saved connection and reports a dead one as `unreachable`:
//   - the `infra_unreachable` notification card records WHICH areas are failing, so it doubles as
//     the watcher's durable last-observed state (see `kernel/domain/infra-reachability.ts` for why
//     that, and not a store of its own), and
//   - each TRANSITION is pushed as an `infraSetup` realtime event, so the setup banner appears the
//     moment a provider dies instead of on whoever's next reload.
//
// Why this exists at all: a configured-but-dead environment provider fails every testing agent
// while the board reports a perfectly healthy setup. The `configured` presence check the snapshot
// does cannot tell them apart — it asks whether a row exists, not whether anything answers. That
// gap is how an outage sits unnoticed for a day.
//
// A no-op unless the watcher is opted in AND the notifications module is wired. Best-effort per
// workspace: a failed probe/raise for one is logged and skipped, never aborting the others — this
// sweep must not become the silent background failure it exists to catch.

/** One workspace's probeable connection surface, as read off the request container. */
interface ProbeSources {
  ephemeralEnvironments?: (workspaceId: string) => Promise<ConnectionTestResult | null>
  agentExecutor?: (workspaceId: string) => Promise<ConnectionTestResult | null>
}

/**
 * Run one reachability pass across every workspace. Returns how many areas started failing and how
 * many recovered — the two numbers worth a log line; an unchanged pass reports zeros and stays
 * quiet. Enumerates boards from the workspace projection (`workspaceService.list(null)`), the same
 * tenant-enumeration shape the platform-health and artifact-retention sweeps use.
 *
 * Time comes from the notification service's injected clock (`raise`/`clearByType` stamp `now`
 * themselves) and from `Date.now()` for the pushed event, matching every other publisher.
 */
export async function sweepInfraReachability(
  container: ServerContainer,
  logger?: Logger,
): Promise<{ raised: number; cleared: number }> {
  const cfg = container.config.infraReachability
  const notifications = container.notifications
  if (!cfg.enabled || !notifications) return { raised: 0, cleared: 0 }
  // NEVER from a mothership-mode node. This is a DEPLOYMENT-level sweep: every board such a node
  // can see belongs to the org, so each laptop running it would probe every workspace's
  // infrastructure and then race every other laptop on the same shared cards. The mothership runs
  // it. This is also why the card read stays mothership-INTERNAL (`listOpenByType` is classified
  // `sweeper`, not allow-listed on the persistence RPC) — without this guard the pass would fail
  // with `unknown_method` on every interval instead of being cleanly out of scope.
  if (container.config.localMode?.mothership) return { raised: 0, cleared: 0 }

  const sources = probeSources(container)
  // Nothing on this deployment can be probed (neither integration is wired), so the pass would
  // enumerate every board only to skip it. Bail before the workspace read.
  if (!sources.ephemeralEnvironments && !sources.agentExecutor) return { raised: 0, cleared: 0 }

  const workspaces = await container.workspaceService.list(null)
  const workspaceIds = workspaces.map((ws) => ws.id)
  // Which boards already hold an open card — ONE batched read up front rather than a
  // `findOpenByType` point-read per workspace inside the loop (that N+1 would run across the whole
  // deployment every pass). It is also the state `decideReachability` compares against, so the
  // healthy steady state costs exactly this one read plus the probes.
  const cards = await notifications.service.listOpenByType(workspaceIds, 'infra_unreachable')

  let raised = 0
  let cleared = 0
  for (const workspaceId of workspaceIds) {
    try {
      const previous = recordedUnreachableAreas(cards.get(workspaceId))
      const observed = await probeWorkspace(sources, workspaceId, cfg.probeTimeoutMs)
      const decision = decideReachability(previous, observed)
      if (decision.transitions.length === 0) continue

      // Persist FIRST, announce second. The card is the durable record the next pass compares
      // against, so a push that fails after it commits costs one live banner update (the board's
      // own snapshot still folds the card on next load); a push that succeeded against a record
      // that never landed would re-announce the same outage on every subsequent pass.
      if (decision.unreachableAreas.length > 0) {
        await notifications.service.raise(workspaceId, {
          type: 'infra_unreachable',
          blockId: null,
          executionId: null,
          ...cardContent(decision.unreachableAreas),
          payload: { unreachableAreas: decision.unreachableAreas },
        })
      } else {
        await notifications.service.clearByType(workspaceId, 'infra_unreachable')
      }

      for (const change of decision.transitions) {
        if (change.status === 'unreachable') raised += 1
        else cleared += 1
        await publish(container, workspaceId, change)
      }
    } catch (err) {
      logger?.warn('infra-reachability: failed to evaluate workspace', {
        scope: 'infra-reachability',
        workspaceId,
        ...describeError(err),
      })
    }
  }
  return { raised, cleared }
}

/**
 * Bind the per-area probes this deployment can actually run. An area with no wired integration is
 * simply absent, which `decideReachability` treats as "not probed" — so it keeps whatever the card
 * recorded rather than being reported as recovered by a deployment that never asked.
 */
function probeSources(container: ServerContainer): ProbeSources {
  const environments = container.environments?.connectionService
  const runners = container.runners?.connectionService
  return {
    ...(environments
      ? { ephemeralEnvironments: (ws: string) => environments.probeSavedConnection(ws) }
      : {}),
    ...(runners ? { agentExecutor: (ws: string) => runners.probeSavedConnection(ws) } : {}),
  }
}

/**
 * Probe every wired area for one workspace, concurrently — the areas are independent connections,
 * so a slow apiserver must not serialise behind a slow runner pool.
 */
async function probeWorkspace(
  sources: ProbeSources,
  workspaceId: string,
  timeoutMs: number,
): Promise<ProbeOutcome[]> {
  const wired = INFRA_SETUP_PROBED_AREAS.filter((area) => sources[area])
  return Promise.all(
    wired.map((area) => probeArea(() => sources[area]!(workspaceId), area, timeoutMs)),
  )
}

/**
 * Run one area's probe into a {@link ProbeOutcome}.
 *
 * The three results are deliberately distinct (degrade loudly): a probe that ANSWERED `ok: false`
 * — or didn't answer inside the budget — is a real outage; a probe that THREW, or that reported
 * nothing to test, is INDETERMINATE. A throw here is a local fault (the connection wouldn't
 * resolve, its secret bundle wouldn't decrypt — the classic case being a node with no access to the
 * sealing key), and blaming the operator's cluster for our own missing key is exactly the
 * "never infer a cause from the presence of an error" trap.
 */
async function probeArea(
  probe: () => Promise<ConnectionTestResult | null>,
  area: InfraSetupArea,
  timeoutMs: number,
): Promise<ProbeOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs)
    })
    const result = await Promise.race([probe(), timeout])
    if (result === 'timeout') {
      return { area, verdict: 'unreachable', detail: `No answer within ${timeoutMs}ms` }
    }
    if (result === null) return { area, verdict: 'indeterminate' }
    if (result.ok) return { area, verdict: 'reachable' }
    // A provider's failure message routinely echoes the request URL it called, which can carry a
    // token in the query — so it is scrubbed here, at the point it becomes operator-facing text.
    const detail = result.message ? redactSecrets(result.message) : null
    return { area, verdict: 'unreachable', ...(detail ? { detail } : {}) }
  } catch {
    return { area, verdict: 'indeterminate' }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Human-facing card text, derived from the failing AREAS only (see the payload's dedup note). */
function cardContent(areas: readonly InfraSetupArea[]): { title: string; body: string } {
  const names: Record<InfraSetupArea, string> = {
    ephemeralEnvironments: 'the ephemeral-environment provider',
    agentExecutor: 'the self-hosted runner pool',
    binaryStorage: 'binary storage',
  }
  const listed = areas.map((area) => names[area]).join(' and ')
  return {
    title: 'Infrastructure is unreachable',
    body: `A live probe could not reach ${listed}. It is configured, so this is an outage rather than a setup gap — the agents that depend on it cannot run until it answers again.`,
  }
}

/** Push one transition, best-effort: a failed push must never abort the pass. */
async function publish(
  container: ServerContainer,
  workspaceId: string,
  change: InfraSetupTransition,
): Promise<void> {
  const publisher = container.executionEventPublisher
  if (!publisher.infraSetupChanged) return
  await runBestEffort(
    container.logger,
    'infra-reachability publish',
    () => publisher.infraSetupChanged!(workspaceId, change),
    { workspaceId, area: change.area, status: change.status },
  )
}
