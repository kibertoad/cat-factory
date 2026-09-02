import { describe, expect, it } from 'vitest'
import { createRecordingLogger } from '@cat-factory/kernel'
import type {
  EnvironmentProvider,
  EnvironmentRecord,
  ProvisionedEnvironment,
  RouteProbe,
  SecretCipher,
} from '@cat-factory/kernel'
import { ROUTE_REPROVE_MIN_INTERVAL_MS } from './environmentReachability.js'
import {
  fakeProvisioningLog,
  fakeRegistry,
  makeService,
  READY,
  recordingProvider,
} from './test-support/environment-provisioning-fakes.js'

// ONE status poll, driven through the `refreshStatus` delegate that owns it.
//
// Its own suite because every rule here is about what a SECOND look at an environment may
// overwrite: which of the previous answer's values survive it, which are cleared unless restated,
// what the fact of the poll itself leaves behind, and when a route proof it had to drop is
// re-taken. The lifecycle around it (provision, supersede, the pre-flight gate) has nothing to
// reconcile and lives in `EnvironmentProvisioningService.test.ts`.

// Hoisted to module scope when the one long suite was split: two of the three suites below
// need a provider that answers a poll differently from its create.
/**
 * Comes up `provisioning` with the thin bag a create response carries, then answers each poll
 * with the richer one the same provider only learns later. The shape every asynchronous
 * provider has: the create response is the least informative answer it will ever give.
 */
function capturesMoreOnEachPoll(polls: readonly ProvisionedEnvironment['fields'][]) {
  const base: ProvisionedEnvironment = {
    externalId: 'ext-1',
    url: 'https://pr-9.preview.test',
    status: 'ready',
    expiresAt: null,
    access: null,
    fields: { externalId: 'ext-1', kargoStatus: 'pending' },
  }
  let poll = 0
  return {
    async provision() {
      return { ...base, status: 'provisioning' as const, url: null }
    },
    async status() {
      return { ...base, fields: polls[Math.min(poll++, polls.length - 1)] ?? null }
    },
    async teardown() {
      return { status: 'torn_down' as const }
    },
  } satisfies EnvironmentProvider
}

describe('the environment status poll (refreshStatus)', () => {
  const FAILED_REASON =
    'invalid environment config: file or ref not found: 404 No commit found for the ref cat-factory/env-test/x'

  /** Provisions `provisioning`, then reports `failed` (with a reason) on the next status poll. */
  function comesUpFailed(): EnvironmentProvider {
    const provisioning: ProvisionedEnvironment = {
      externalId: 'ext-1',
      url: null,
      status: 'provisioning',
      expiresAt: null,
      access: null,
      fields: { externalId: 'ext-1' },
    }
    return {
      async provision() {
        return provisioning
      },
      async status() {
        return { ...provisioning, status: 'failed', error: FAILED_REASON }
      },
      async teardown() {
        return { status: 'torn_down' }
      },
    }
  }

  it("persists the provider's failure reason as lastError on a failed status poll", async () => {
    const registry = fakeRegistry()
    const service = makeService(comesUpFailed(), registry)
    await service.provision({ workspaceId: 'ws1', blockId: 'blk1' })
    const id = registry.records[0]!.id
    // Recorded as `provisioning` with no error yet.
    expect(registry.records[0]!.status).toBe('provisioning')
    expect(registry.records[0]!.lastError).toBeNull()

    const handle = await service.refreshStatus('ws1', id)

    expect(handle.status).toBe('failed')
    // The provider's reason is persisted + surfaced (previously the patch dropped lastError, so a
    // poll-time failure carried a stale/empty reason).
    expect(handle.lastError).toBe(FAILED_REASON)
    expect(registry.records[0]!.lastError).toBe(FAILED_REASON)
  })

  it('counts a poll the provider ANSWERED with a failure, and records the transition', async () => {
    // The marker counts ANSWERS, never successes. A provider reporting a deterministic rejection
    // on `provisioned.error` rather than throwing has answered, so its polls are polling that
    // happened; rendering the count as "22 successful polls" for an environment that failed all
    // 22 is the over-claim class this whole change exists to remove.
    const registry = fakeRegistry()
    const log = fakeProvisioningLog()
    const service = makeService(comesUpFailed(), registry, undefined, {
      provisioningLog: log.recorder,
    })
    await service.provision({ workspaceId: 'ws1', blockId: 'blk1' })
    const id = registry.records[0]!.id

    await service.refreshStatus('ws1', id)

    expect(registry.records[0]!.pollCount).toBe(1)
    expect(registry.records[0]!.lastPolledAt).toBe(1_700_000_000_000)
    // And the transition itself is still a log row, which is the other half of the record: the
    // count says polling happened, the row says what the answer was.
    expect(
      log.rows.filter((row) => row.operation === 'status' && row.outcome === 'failure'),
    ).toEqual([expect.objectContaining({ error: FAILED_REASON })])
  })

  it('does NOT file a platform cipher failure as a provider status failure', async () => {
    // The provisioning log is what the run's "Infrastructure attempts" renders and what the
    // investigation's timeline reads, so the subsystem a row names is an attribution. Opening the
    // sealed field bag is the platform's own work against its own cipher (a mothership node opens
    // a row the mothership sealed), and a key-routing fault filed as `environment.status` failure
    // sends a reader to the provider: the exact misattribution this change is about.
    const registry = fakeRegistry()
    const log = fakeProvisioningLog()
    const brokenCipher: SecretCipher = {
      encrypt: async (plaintext: string) => `enc:${plaintext}`,
      decrypt: async () => {
        throw new Error('no decryption key for this deployment')
      },
    }
    const service = makeService(recordingProvider(READY), registry, undefined, {
      provisioningLog: log.recorder,
      secretCipher: brokenCipher,
    })
    await service.provision({ workspaceId: 'ws1', blockId: 'blk1' })
    const id = registry.records[0]!.id

    await expect(service.refreshStatus('ws1', id)).rejects.toThrow('no decryption key')

    expect(log.rows.filter((row) => row.operation === 'status')).toEqual([])
  })

  it('SAYS SO when the provisioning log refuses a failed transition', async () => {
    // The swallow is right (the environment is already persisted as `failed` and the row is
    // advisory) and silence is not: a recorder that starts failing would otherwise stop recording
    // every failed transition, which is the one surfacing that block exists to guarantee.
    const registry = fakeRegistry()
    const log = fakeProvisioningLog({
      refuse: { operation: 'status', error: new Error('persistence RPC refused this method') },
    })
    const logger = createRecordingLogger()
    const service = makeService(comesUpFailed(), registry, undefined, {
      provisioningLog: log.recorder,
      logger,
    })
    await service.provision({ workspaceId: 'ws1', blockId: 'blk1' })
    const id = registry.records[0]!.id

    const handle = await service.refreshStatus('ws1', id)

    expect(handle.status).toBe('failed')
    const warned = logger.lines.find((line) => line.level === 'warn')
    expect(warned?.msg).toContain('environmentStatusPoll.recordFailedTransition')
    expect(String(warned?.fields?.err)).toContain('persistence RPC refused this method')
  })

  /** The stored field bag, as the passthrough cipher leaves it. */
  function storedFields(record: EnvironmentRecord): unknown {
    return JSON.parse((record.provisionFieldsCipher ?? 'enc:null').replace(/^enc:/, ''))
  }

  it('persists what a status poll captured, so a later observation is not thrown away', async () => {
    // Issue #2162. `refreshStatus` handed the whole bag back to the provider and then persisted a
    // patch that omitted it, so a provider's fields were frozen at create time for the life of the
    // environment: the readiness detail, the balancer FQDNs and the provider's own status message
    // all arrive on a poll, and every one of them was discarded. The environment investigation
    // then read a create-time `kargoStatus: pending` sitting beside a `ready` row and built its
    // headline on the platform contradicting itself.
    const registry = fakeRegistry()
    const service = makeService(
      capturesMoreOnEachPoll([
        { externalId: 'ext-1', kargoStatus: 'ready', kargoServing: 'pr-9', balancer: '10.4.19.22' },
      ]),
      registry,
    )
    await service.provision({ workspaceId: 'ws1', blockId: 'blk1' })
    const id = registry.records[0]!.id
    expect(storedFields(registry.records[0]!)).toEqual({
      externalId: 'ext-1',
      kargoStatus: 'pending',
    })

    await service.refreshStatus('ws1', id)

    // REPLACED, not merged: the bag is what THIS response captured, so a key the provider has
    // stopped stating has stopped being stored. A bag nothing can clear is the trap the
    // clear-unless-restated rule on `lastError` and `statusNote` exists to avoid.
    expect(storedFields(registry.records[0]!)).toEqual({
      externalId: 'ext-1',
      kargoStatus: 'ready',
      kargoServing: 'pr-9',
      balancer: '10.4.19.22',
    })
  })

  it('KEEPS the stored bag when a poll states nothing about the fields at all', async () => {
    // Absent is not empty, the same rule the addresses beside it follow. A status endpoint
    // answering a narrower shape than the create endpoint (or the no-`status`-template fallback)
    // states nothing, and erasing teardown state on its say-so is how a reclaim breaks.
    const registry = fakeRegistry()
    const service = makeService(capturesMoreOnEachPoll([null]), registry)
    await service.provision({ workspaceId: 'ws1', blockId: 'blk1' })
    const id = registry.records[0]!.id

    await service.refreshStatus('ws1', id)

    expect(storedFields(registry.records[0]!)).toEqual({
      externalId: 'ext-1',
      kargoStatus: 'pending',
    })
  })

  it('leaves a trail for a poll that SUCCEEDS, which nothing else on this path records', async () => {
    // Issue #2163. The provisioning log records a poll that throws and a poll that turns the env
    // `failed`; a clean answer wrote nothing, so a readiness wait that polled successfully for
    // four minutes left two rows a second apart at the create and nothing after them. An
    // investigation read that absence as the absence of polling and stated it as fact.
    const registry = fakeRegistry()
    let now = 1_700_000_000_000
    const service = makeService(capturesMoreOnEachPoll([null]), registry, undefined, {
      clock: { now: () => now },
    })
    await service.provision({ workspaceId: 'ws1', blockId: 'blk1' })
    const id = registry.records[0]!.id
    // A freshly recorded environment has by construction never been polled, and says so rather
    // than carrying a stamp nobody earned.
    expect(registry.records[0]!.lastPolledAt).toBeNull()
    expect(registry.records[0]!.pollCount).toBe(0)

    now += 225_000
    await service.refreshStatus('ws1', id)
    now += 10_000
    await service.refreshStatus('ws1', id)

    expect(registry.records[0]!.pollCount).toBe(2)
    expect(registry.records[0]!.lastPolledAt).toBe(1_700_000_235_000)
  })
})

// The half of one poll that decides whether the platform still knows how to REACH the
// environment. Its own suite because the rule is not about persistence at all: it is about which
// stored verdict a freshly stated candidate list leaves standing, and who re-takes one it does not
// (the deployer's settle path will not run again for a frame that already settled).
describe('the environment status poll: the route re-prove', () => {
  /** A `ready` environment whose provider re-points it at a different balancer on every poll. */
  function movesItsBalancer(): {
    provider: EnvironmentProvider
    dialled: string[]
    probe: RouteProbe
  } {
    const dialled: string[] = []
    const moved: ProvisionedEnvironment = {
      externalId: 'ext-1',
      url: 'https://pr-9.preview.test',
      status: 'ready',
      expiresAt: null,
      access: null,
      fields: null,
      addresses: [{ address: '10.4.19.30', label: 'replacement ALB' }],
    }
    return {
      dialled,
      probe: async (req) => {
        dialled.push(req.address ?? req.host)
        return req.address ? { state: 'carried' } : { state: 'unresolved' }
      },
      provider: {
        async provision() {
          return { ...moved, addresses: [{ address: '10.4.19.22' }] }
        },
        async status() {
          return moved
        },
        async teardown() {
          return { status: 'torn_down' as const }
        },
      } satisfies EnvironmentProvider,
    }
  }

  it('RE-PROVES a route the poll invalidated, instead of leaving the row with no proof', async () => {
    // Issue #2165's other half. `proveEnvironmentRoute` is otherwise reached from exactly one
    // place, the deployer's frame settle, which never runs again for a frame that already settled.
    // So a proof a later poll legitimately invalidated (here: the provider re-points the
    // environment at a different balancer) was dropped and never re-taken, and everything built on
    // it stopped silently, because a dropped proof and a proof never taken are the same value.
    const registry = fakeRegistry()
    const { provider, dialled, probe } = movesItsBalancer()
    let now = 1_700_000_000_000
    const service = makeService(provider, registry, undefined, {
      routeProbe: probe,
      clock: { now: () => now },
    })
    await service.provision({ workspaceId: 'ws1', blockId: 'blk1' })
    const id = registry.records[0]!.id
    const proved = await service.proveReachability('ws1', id)
    expect(proved.reachability?.proof).toMatchObject({ state: 'reached', via: '10.4.19.22' })

    now += ROUTE_REPROVE_MIN_INTERVAL_MS
    const refreshed = await service.refreshStatus('ws1', id)

    // The stored verdict really was stale: the address it vouched for is not on offer any more.
    // What matters is that a NEW one was taken against what is, rather than the row being left
    // with the same value it would carry if nothing had ever looked.
    expect(refreshed.reachability?.candidates.map((c) => c.address)).toEqual(['10.4.19.30'])
    expect(refreshed.reachability?.proof).toMatchObject({ state: 'reached', via: '10.4.19.30' })
    expect(dialled).toEqual(['pr-9.preview.test', '10.4.19.22', 'pr-9.preview.test', '10.4.19.30'])
  })

  it('HOLDS OFF re-proving while the last probe is inside the re-prove interval', async () => {
    // The bound on the re-take. This poll runs on a ten-second cadence inside the deployer's
    // readiness wait, and a proof costs up to five sequential dials at four seconds each: an
    // environment whose provider re-states a different candidate set on every answer (a balancer
    // scaling across zones does exactly that) would otherwise turn every poll into twenty seconds
    // of blocking I/O inside a durable step, indefinitely.
    const registry = fakeRegistry()
    const { provider, dialled, probe } = movesItsBalancer()
    let now = 1_700_000_000_000
    const service = makeService(provider, registry, undefined, {
      routeProbe: probe,
      clock: { now: () => now },
    })
    await service.provision({ workspaceId: 'ws1', blockId: 'blk1' })
    const id = registry.records[0]!.id
    await service.proveReachability('ws1', id)
    dialled.length = 0

    now += ROUTE_REPROVE_MIN_INTERVAL_MS - 1
    const held = await service.refreshStatus('ws1', id)
    expect(dialled).toEqual([])
    // No proof rather than the stale one: the fold dropped it because it no longer establishes
    // anything about the addresses on offer, and keeping it would be the worse of the two lies.
    expect(held.reachability?.proof ?? null).toBeNull()

    now += 1
    await service.refreshStatus('ws1', id)
    expect(dialled).toEqual(['pr-9.preview.test', '10.4.19.30'])
  })

  it('re-proves an environment whose stored proof says nothing was ever WIRED to probe', async () => {
    // `unproved` is a proof never TAKEN, and it survives the fold forever on set equality, so
    // treating it as a live proof left every environment that settled before a deployment wired
    // its prober permanently unproved. It is the one surviving shape the re-take must replace.
    const registry = fakeRegistry()
    const { provider, dialled, probe } = movesItsBalancer()
    let now = 1_700_000_000_000
    const clock = { now: () => now }
    const unwired = makeService(provider, registry, undefined, { clock })
    await unwired.provision({ workspaceId: 'ws1', blockId: 'blk1' })
    const id = registry.records[0]!.id
    const unproved = await unwired.proveReachability('ws1', id)
    expect(unproved.reachability?.proof).toMatchObject({ state: 'unproved', attempts: [] })

    // The same deployment, one release later, with a facade that can open a socket.
    now += ROUTE_REPROVE_MIN_INTERVAL_MS
    const wired = makeService(provider, registry, undefined, { clock, routeProbe: probe })
    const refreshed = await wired.refreshStatus('ws1', id)

    expect(refreshed.reachability?.proof).toMatchObject({ state: 'reached', via: '10.4.19.30' })
    expect(dialled).toEqual(['pr-9.preview.test', '10.4.19.30'])
  })

  it('re-proves an environment whose stored proof says nothing could RESOLVE its balancer', async () => {
    // The `unproved` trap in the shape the state alone cannot show. A proof recording that this
    // deployment had nothing to turn a stated NAME into an address is `inconclusive`, so it is not
    // `unproved`, and it survives the fold forever on set equality: left as a live proof it would
    // leave such an environment unproved for its whole life, including after the deployment wired
    // a resolver.
    const dialled: string[] = []
    const registry = fakeRegistry()
    const provider = {
      async provision() {
        return {
          externalId: 'ext-1',
          url: 'https://pr-9.preview.test',
          status: 'ready' as const,
          expiresAt: null,
          access: null,
          fields: null,
          addresses: [{ host: 'alb-4.elb.preview.test', label: 'public ALB' }],
        }
      },
      async status() {
        return {
          externalId: 'ext-1',
          url: 'https://pr-9.preview.test',
          status: 'ready' as const,
          expiresAt: null,
          access: null,
          fields: null,
          addresses: [{ host: 'alb-4.elb.preview.test', label: 'public ALB' }],
        }
      },
      async teardown() {
        return { status: 'torn_down' as const }
      },
    } satisfies EnvironmentProvider
    const probe: RouteProbe = async (req) => {
      dialled.push(req.address ?? req.host)
      return req.address ? { state: 'carried' } : { state: 'unresolved' }
    }
    let now = 1_700_000_000_000
    const clock = { now: () => now }
    const noResolver = makeService(provider, registry, undefined, { clock, routeProbe: probe })
    await noResolver.provision({ workspaceId: 'ws1', blockId: 'blk1' })
    const id = registry.records[0]!.id
    const unresolvable = await noResolver.proveReachability('ws1', id)
    expect(unresolvable.reachability?.proof).toMatchObject({
      state: 'inconclusive',
      reason: 'resolver_unavailable',
    })

    // Nothing is still wired, so the poll leaves it alone rather than paying a dial sequence a
    // minute to re-derive the answer it has.
    now += ROUTE_REPROVE_MIN_INTERVAL_MS
    dialled.length = 0
    await noResolver.refreshStatus('ws1', id)
    expect(dialled).toEqual([])

    // The same deployment, one release later, with a resolver.
    now += ROUTE_REPROVE_MIN_INTERVAL_MS
    const wired = makeService(provider, registry, undefined, {
      clock,
      routeProbe: probe,
      hostResolver: async () => ({ state: 'resolved', addresses: ['10.4.19.30'] }),
    })
    const refreshed = await wired.refreshStatus('ws1', id)
    expect(refreshed.reachability?.proof).toMatchObject({
      state: 'reached',
      via: '10.4.19.30',
      viaHost: 'alb-4.elb.preview.test',
    })
    expect(dialled).toEqual(['pr-9.preview.test', '10.4.19.30'])
  })

  it('takes no FIRST proof on a poll: only one the poll itself invalidated is re-taken', async () => {
    // The narrowing that keeps a socket off the hot path. Nothing has proved a `provisioning`
    // environment yet, and probing here would dial on every poll of every environment whose
    // deployer has not settled it; the settle path owns the first proof.
    const dialled: string[] = []
    const registry = fakeRegistry()
    const service = makeService(capturesMoreOnEachPoll([null]), registry, undefined, {
      routeProbe: async (req) => {
        dialled.push(req.address ?? req.host)
        return { state: 'carried' }
      },
    })
    await service.provision({ workspaceId: 'ws1', blockId: 'blk1' })
    await service.refreshStatus('ws1', registry.records[0]!.id)
    expect(dialled).toEqual([])
  })

  it('leaves a dropped proof alone while the environment is not ready again', async () => {
    // The other half of the same narrowing: an environment that has gone back to `provisioning`
    // is one whose route is not worth dialling yet, and its own settle path will prove it when it
    // comes up. Re-taking here would record a `not_reached` about an environment mid-rollout.
    const dialled: string[] = []
    const registry = fakeRegistry()
    let poll = 0
    const service = makeService(
      {
        async provision() {
          return {
            externalId: 'ext-1',
            url: 'https://pr-9.preview.test',
            status: 'ready' as const,
            expiresAt: null,
            access: null,
            fields: null,
            addresses: [{ address: '10.4.19.22' }],
          }
        },
        async status() {
          poll += 1
          return {
            externalId: 'ext-1',
            url: 'https://pr-9.preview.test',
            status: 'provisioning' as const,
            expiresAt: null,
            access: null,
            fields: null,
            addresses: [{ address: `10.4.19.${30 + poll}` }],
          }
        },
        async teardown() {
          return { status: 'torn_down' as const }
        },
      } satisfies EnvironmentProvider,
      registry,
      undefined,
      {
        routeProbe: async (req) => {
          dialled.push(req.address ?? req.host)
          return req.address ? { state: 'carried' } : { state: 'unresolved' }
        },
      },
    )
    await service.provision({ workspaceId: 'ws1', blockId: 'blk1' })
    const id = registry.records[0]!.id
    await service.proveReachability('ws1', id)
    dialled.length = 0

    const refreshed = await service.refreshStatus('ws1', id)

    expect(refreshed.reachability?.proof ?? null).toBeNull()
    expect(dialled).toEqual([])
  })
})

// What the provider says about a state it has not LEFT yet, which is the one field `lastError` is
// structurally null for: a `provisioning` environment has no error to report and every readiness
// wait that gave up used to report only how long it waited.
describe("the environment status poll: the provider's own status note", () => {
  /** Stays `provisioning`, saying something different about it on each poll. */
  function narratesItsProgress(notes: readonly (string | undefined)[]): EnvironmentProvider {
    const base: ProvisionedEnvironment = {
      externalId: 'ext-1',
      url: null,
      status: 'provisioning',
      expiresAt: null,
      access: null,
      fields: { externalId: 'ext-1' },
    }
    let poll = 0
    return {
      async provision() {
        return { ...base, statusNote: notes[0] }
      },
      async status() {
        poll += 1
        return { ...base, statusNote: notes[poll] }
      },
      async teardown() {
        return { status: 'torn_down' }
      },
    }
  }

  it("persists a provisioning provider's note, which is the status lastError is nulled on", async () => {
    // Issue #2153: `lastError` is written on `failed` alone, so a provider that knew exactly why
    // an environment was not ready yet had no column to say it in and the readiness ceiling could
    // only report its own duration.
    const registry = fakeRegistry()
    const service = makeService(narratesItsProgress(['  the deploy job is queued  ']), registry)
    await service.provision({ workspaceId: 'ws1', blockId: 'blk1' })

    expect(registry.records[0]!.status).toBe('provisioning')
    expect(registry.records[0]!.statusNote).toBe('the deploy job is queued')
    // And it is not smuggled in under the error's name, which would report a fault on a healthy
    // spin-up everywhere `lastError` is rendered.
    expect(registry.records[0]!.lastError).toBeNull()
  })

  it('rewrites the note from the current poll, so a stale one cannot outlive its state', async () => {
    const registry = fakeRegistry()
    const service = makeService(
      narratesItsProgress(['the deploy job is queued', 'the deploy job is running', undefined]),
      registry,
    )
    await service.provision({ workspaceId: 'ws1', blockId: 'blk1' })
    const id = registry.records[0]!.id

    expect((await service.refreshStatus('ws1', id)).statusNote).toBe('the deploy job is running')
    // A provider that stops saying anything clears it: the note is the CURRENT account, never a
    // log, so the last thing said does not linger over a state that has moved on.
    expect((await service.refreshStatus('ws1', id)).statusNote).toBeNull()
    expect(registry.records[0]!.statusNote).toBeNull()
  })

  it('bounds the note at the write boundary, whatever the adapter answered with', async () => {
    // The note is provider-authored prose, and a code adapter can answer with a controller dump.
    // Bounding it HERE covers every reader at once (the panel line, the readiness ceiling's
    // failure message, the outcome row), which is why the cap is not a rendering concern.
    const registry = fakeRegistry()
    const service = makeService(narratesItsProgress(['n'.repeat(900)]), registry)
    await service.provision({ workspaceId: 'ws1', blockId: 'blk1' })

    const stored = registry.records[0]!.statusNote!
    expect(stored.length).toBeLessThan(500)
    expect(stored).toContain('note truncated')
  })
})
