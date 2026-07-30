import type { ConnectionTestResult } from '@cat-factory/contracts'
import {
  createRecordingLogger,
  type InfraSetupTransition,
  type Workspace,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import type { ServerContainer } from '../src/http/env.js'
import { sweepInfraReachability } from '../src/runtime/infraReachability.js'

// Drives the runtime-neutral reachability sweep over a minimal fake container: only the fields it
// reads (config.infraReachability, workspaceService.list, the two connection services'
// probeSavedConnection, notifications.service.listOpenByType/raise/clearByType and the event
// publisher) are present, cast to ServerContainer. Mirrors `platformHealthSweep.spec.ts`.

const workspace = (id: string): Workspace => ({
  id,
  name: id,
  description: null,
  createdAt: 0,
  accountId: 'acc-1',
})

/**
 * A probe outcome per workspace: a provider verdict, one of the two non-answers the connection
 * services distinguish (`absent` = nothing registered, `unprobeable` = we could not ask), or a
 * thrown error. Absent from the table ⇒ `absent`.
 */
type Probe = ConnectionTestResult | 'absent' | 'unprobeable' | Error

function makeContainer(opts: {
  workspaces?: Workspace[]
  environments?: Record<string, Probe>
  runners?: Record<string, Probe>
  /** Areas already recorded on each workspace's open `infra_unreachable` card. */
  recorded?: Record<string, string[]>
  enabled?: boolean
  hasNotifications?: boolean
  probeTimeoutMs?: number
  /** Omit the publisher's optional method, modelling a runtime with no real-time transport. */
  hasPublisher?: boolean
  /** A workspace whose card write throws, to exercise the per-workspace failure isolation. */
  failRaiseFor?: string
  /** A workspace whose runner-pool probe never settles, to exercise the per-probe timeout. */
  hangRunnerFor?: string
  /** Model a mothership-mode local node (no main database; org state over the machine RPC). */
  mothership?: boolean
  /** Whether the runner pool is this deployment's SOLE agent executor (else `not_applicable`). */
  agentExecutorApplies?: boolean
  /** Whether an environment-provider connection is mandatory here (else `not_applicable`). */
  ephemeralEnvironmentsApplies?: boolean
}) {
  const raises: { workspaceId: string; areas: unknown }[] = []
  const clears: string[] = []
  const published: { workspaceId: string; change: InfraSetupTransition }[] = []
  const listByTypeCalls: string[][] = []
  const probeCalls: string[] = []
  const logger = createRecordingLogger()

  const bindProbe = (table: Record<string, Probe> | undefined, label: string) =>
    table
      ? {
          connectionService: {
            probeSavedConnection: async (workspaceId: string) => {
              probeCalls.push(`${label}:${workspaceId}`)
              if (label === 'pool' && workspaceId === opts.hangRunnerFor) {
                return new Promise<ConnectionTestResult>(() => {})
              }
              const outcome = table[workspaceId] ?? 'absent'
              if (outcome instanceof Error) throw outcome
              if (outcome === 'absent') return { state: 'absent' }
              if (outcome === 'unprobeable')
                return { state: 'unprobeable', reason: 'no connection test' }
              return { state: 'answered', result: outcome }
            },
          },
        }
      : undefined

  const container = {
    config: {
      infraReachability: {
        enabled: opts.enabled ?? true,
        intervalMs: 60_000,
        probeTimeoutMs: opts.probeTimeoutMs ?? 5_000,
      },
      ...(opts.mothership ? { localMode: { enabled: true, mothership: true } } : {}),
    },
    // The projection's applicability flags. The sweep gates its probes on the SAME predicate, so a
    // deployment where the pool is an optional alternate target (Cloudflare, local mode) is never
    // told it is down — see `infraSetupAreaApplies`.
    agentExecutorRequiresRunnerPool: opts.agentExecutorApplies ?? true,
    ephemeralEnvironmentsRequireProvider: opts.ephemeralEnvironmentsApplies ?? true,
    logger,
    workspaceService: { list: async () => opts.workspaces ?? [workspace('ws-1')] },
    environments: bindProbe(opts.environments, 'env'),
    runners: bindProbe(opts.runners, 'pool'),
    executionEventPublisher:
      opts.hasPublisher === false
        ? {}
        : {
            infraSetupChanged: async (workspaceId: string, change: InfraSetupTransition) => {
              published.push({ workspaceId, change })
            },
          },
    notifications:
      opts.hasNotifications === false
        ? undefined
        : {
            service: {
              listOpenByType: async (workspaceIds: string[]) => {
                listByTypeCalls.push(workspaceIds)
                return new Map(
                  Object.entries(opts.recorded ?? {})
                    .filter(([id]) => workspaceIds.includes(id))
                    .map(([id, areas]) => [
                      id,
                      {
                        type: 'infra_unreachable',
                        status: 'open',
                        payload: { unreachableAreas: areas },
                      },
                    ]),
                )
              },
              raise: async (
                workspaceId: string,
                input: { payload?: { unreachableAreas?: unknown } },
              ) => {
                if (workspaceId === opts.failRaiseFor) throw new Error('write failed')
                raises.push({ workspaceId, areas: input.payload?.unreachableAreas })
                return {}
              },
              clearByType: async (workspaceId: string) => {
                clears.push(workspaceId)
                return {}
              },
            },
          },
  } as unknown as ServerContainer
  return { container, raises, clears, published, listByTypeCalls, probeCalls }
}

const OK: ConnectionTestResult = { ok: true }
const DOWN: ConnectionTestResult = { ok: false, message: 'connect ECONNREFUSED 10.0.0.4:6443' }

describe('sweepInfraReachability', () => {
  it('records a new outage and publishes the transition', async () => {
    const { container, raises, published } = makeContainer({ runners: { 'ws-1': DOWN } })
    expect(await sweepInfraReachability(container)).toEqual({ raised: 1, cleared: 0 })
    expect(raises).toEqual([{ workspaceId: 'ws-1', areas: ['agentExecutor'] }])
    expect(published).toEqual([
      {
        workspaceId: 'ws-1',
        change: {
          area: 'agentExecutor',
          status: 'unreachable',
          detail: 'connect ECONNREFUSED 10.0.0.4:6443',
        },
      },
    ])
  })

  it('stays silent while an already-recorded outage persists', async () => {
    // The core anti-storm property: the watcher polls on a sweep cadence, so an ongoing outage must
    // announce exactly once. Nothing is raised or published on the second pass.
    const { container, raises, published } = makeContainer({
      runners: { 'ws-1': DOWN },
      recorded: { 'ws-1': ['agentExecutor'] },
    })
    expect(await sweepInfraReachability(container)).toEqual({ raised: 0, cleared: 0 })
    expect(raises).toEqual([])
    expect(published).toEqual([])
  })

  it('clears the card and announces the recovery', async () => {
    const { container, clears, published } = makeContainer({
      runners: { 'ws-1': OK },
      recorded: { 'ws-1': ['agentExecutor'] },
    })
    expect(await sweepInfraReachability(container)).toEqual({ raised: 0, cleared: 1 })
    expect(clears).toEqual(['ws-1'])
    expect(published).toEqual([
      { workspaceId: 'ws-1', change: { area: 'agentExecutor', status: 'configured' } },
    ])
  })

  it('keeps the card when only ONE of two recorded areas recovers', async () => {
    const { container, raises, clears } = makeContainer({
      environments: { 'ws-1': DOWN },
      runners: { 'ws-1': OK },
      recorded: { 'ws-1': ['agentExecutor', 'ephemeralEnvironments'] },
    })
    expect(await sweepInfraReachability(container)).toEqual({ raised: 0, cleared: 1 })
    // Re-raised with the REDUCED set (not cleared): one area is still down.
    expect(raises).toEqual([{ workspaceId: 'ws-1', areas: ['ephemeralEnvironments'] }])
    expect(clears).toEqual([])
  })

  it('treats a THROWING probe as indeterminate, not as an outage', async () => {
    // A throw is a LOCAL fault (unresolvable connection, undecryptable secret bundle). Blaming the
    // operator's cluster for our own missing key is exactly the wrong report.
    const { container, raises, published } = makeContainer({
      runners: { 'ws-1': new Error('secret decrypt failed') },
    })
    expect(await sweepInfraReachability(container)).toEqual({ raised: 0, cleared: 0 })
    expect(raises).toEqual([])
    expect(published).toEqual([])
  })

  it('treats an UNPROBEABLE connection as indeterminate, not as a recovery', async () => {
    // "We could not ask" (a de-registered backend kind, an unparseable config) must leave the
    // record exactly as it was — it is our own gap, not evidence the cluster came back.
    const { container, clears, raises } = makeContainer({
      runners: { 'ws-1': 'unprobeable' },
      recorded: { 'ws-1': ['agentExecutor'] },
    })
    expect(await sweepInfraReachability(container)).toEqual({ raised: 0, cleared: 0 })
    expect(clears).toEqual([])
    expect(raises).toEqual([])
  })

  it('clears a recorded outage once the connection is GONE, announcing nothing', async () => {
    // The stuck-card fix: an operator who fixes a dead runner pool by un-registering it must not
    // keep an escalating `infra_unreachable` card forever. "Absent" is knowably not an outage, so
    // the card clears — but no recovery is published, because nothing recovered.
    const { container, clears, published } = makeContainer({
      runners: { 'ws-1': 'absent' },
      recorded: { 'ws-1': ['agentExecutor'] },
    })
    expect(await sweepInfraReachability(container)).toEqual({ raised: 0, cleared: 0 })
    expect(clears).toEqual(['ws-1'])
    expect(published).toEqual([])
  })

  it('re-raises with the reduced set when one of two recorded areas is gone', async () => {
    const { container, raises, clears } = makeContainer({
      environments: { 'ws-1': DOWN },
      runners: { 'ws-1': 'absent' },
      recorded: { 'ws-1': ['agentExecutor', 'ephemeralEnvironments'] },
    })
    await sweepInfraReachability(container)
    expect(raises).toEqual([{ workspaceId: 'ws-1', areas: ['ephemeralEnvironments'] }])
    expect(clears).toEqual([])
  })

  it('never probes an area this deployment reports as not_applicable', async () => {
    // The runner pool is an optional alternate target on Cloudflare and local mode, where the
    // projection says `not_applicable` — so a dead one must raise nothing. Probing it anyway paged
    // Slack for an outage whose banner the snapshot fold then refused to render.
    const { container, probeCalls, raises, published } = makeContainer({
      runners: { 'ws-1': DOWN },
      agentExecutorApplies: false,
    })
    expect(await sweepInfraReachability(container)).toEqual({ raised: 0, cleared: 0 })
    expect(probeCalls).toEqual([])
    expect(raises).toEqual([])
    expect(published).toEqual([])
  })

  it('probes the environment provider only where a provider connection is mandatory', async () => {
    const { container, probeCalls } = makeContainer({
      environments: { 'ws-1': DOWN },
      ephemeralEnvironmentsApplies: false,
    })
    expect(await sweepInfraReachability(container)).toEqual({ raised: 0, cleared: 0 })
    expect(probeCalls).toEqual([])
  })

  it('counts a probe that never answers within the budget as unreachable', async () => {
    // A connection that doesn't answer inside the budget IS the outage this watcher exists to
    // report, so a timeout is a verdict — and one hung apiserver must not stall the whole pass.
    const { container, published } = makeContainer({
      probeTimeoutMs: 5,
      runners: {},
      hangRunnerFor: 'ws-1',
    })
    expect(await sweepInfraReachability(container)).toEqual({ raised: 1, cleared: 0 })
    expect(published[0]?.change).toEqual({
      area: 'agentExecutor',
      status: 'unreachable',
      detail: 'No answer within 5ms',
    })
  })

  it('scrubs a secret out of the probe message before it becomes operator-facing text', async () => {
    const { container, published } = makeContainer({
      runners: {
        'ws-1': { ok: false, message: 'GET https://pool.example/api?token=sk-abcdef123456 failed' },
      },
    })
    await sweepInfraReachability(container)
    expect(published[0]?.change.detail).not.toContain('sk-abcdef123456')
  })

  it('reads the open cards in ONE batched query, not per workspace', async () => {
    const { container, listByTypeCalls } = makeContainer({
      workspaces: [workspace('ws-1'), workspace('ws-2'), workspace('ws-3')],
      runners: { 'ws-1': OK, 'ws-2': OK, 'ws-3': OK },
    })
    await sweepInfraReachability(container)
    expect(listByTypeCalls).toEqual([['ws-1', 'ws-2', 'ws-3']])
  })

  it('keeps evaluating the other workspaces when one fails outright', async () => {
    // This sweep must not become the silent background failure it exists to catch: one board whose
    // card write dies is logged and skipped, never aborting the pass.
    const { container, raises } = makeContainer({
      workspaces: [workspace('ws-1'), workspace('ws-2')],
      runners: { 'ws-1': DOWN, 'ws-2': DOWN },
      failRaiseFor: 'ws-1',
    })
    expect(await sweepInfraReachability(container)).toEqual({ raised: 1, cleared: 0 })
    expect(raises.map((r) => r.workspaceId)).toEqual(['ws-2'])
  })

  it('probes nothing when the watcher is not opted in', async () => {
    const { container, probeCalls } = makeContainer({ enabled: false, runners: { 'ws-1': DOWN } })
    expect(await sweepInfraReachability(container)).toEqual({ raised: 0, cleared: 0 })
    expect(probeCalls).toEqual([])
  })

  it('probes nothing when no probeable integration is wired', async () => {
    // Neither connection service exists (a facade with neither integration), so the pass must bail
    // before it enumerates every board.
    const { container, listByTypeCalls } = makeContainer({})
    expect(await sweepInfraReachability(container)).toEqual({ raised: 0, cleared: 0 })
    expect(listByTypeCalls).toEqual([])
  })

  it('probes nothing when the notifications module is not wired (no durable record)', async () => {
    const { container, probeCalls } = makeContainer({
      hasNotifications: false,
      runners: { 'ws-1': DOWN },
    })
    expect(await sweepInfraReachability(container)).toEqual({ raised: 0, cleared: 0 })
    expect(probeCalls).toEqual([])
  })

  it('still records the outage when the runtime has no real-time transport', async () => {
    // The card is the durable record, so a facade with no publisher still shows the banner on the
    // next board load — it simply doesn't get the live update.
    const { container, raises } = makeContainer({
      hasPublisher: false,
      runners: { 'ws-1': DOWN },
    })
    expect(await sweepInfraReachability(container)).toEqual({ raised: 1, cleared: 0 })
    expect(raises).toEqual([{ workspaceId: 'ws-1', areas: ['agentExecutor'] }])
  })

  it('never sweeps from a mothership-mode node', async () => {
    // A deployment-level sweep, so it belongs on the mothership: every board a mothership-mode node
    // sees is the org's, and N laptops would each probe every workspace and race on the same cards.
    // The card read is mothership-internal too, so an unguarded pass would 'unknown_method' forever.
    const { container, probeCalls, listByTypeCalls } = makeContainer({
      mothership: true,
      runners: { 'ws-1': DOWN },
    })
    expect(await sweepInfraReachability(container)).toEqual({ raised: 0, cleared: 0 })
    expect(probeCalls).toEqual([])
    expect(listByTypeCalls).toEqual([])
  })

  it('only probes the areas whose integration is wired', async () => {
    const { container, probeCalls } = makeContainer({ runners: { 'ws-1': OK } })
    await sweepInfraReachability(container)
    expect(probeCalls).toEqual(['pool:ws-1'])
  })
})
