import type { EnvironmentHandle, EnvironmentProvider, ExecutionInstance } from '@cat-factory/kernel'
import { expect, it } from 'vitest'
import type { ConformanceApp, ConformanceHarness } from '../harness.js'
import { seedLegacyPipeline } from '../legacyPipeline.js'

/**
 * Whether a provisioned environment can be REACHED, which is a different question from whether it
 * was provisioned and the one the platform only ever asserted.
 *
 * Its own file rather than another group inside `integration-environments.ts`, which is at its
 * size budget: these cases share a provider and a driver with each other and with nothing else in
 * that suite. Runtime-neutral by construction, and the cross-runtime risk is concrete: the proof
 * lands in a new column that each facade maps itself (D1 `reachability` TEXT ⇄ the Drizzle
 * column), so a facade that mapped it differently diverges here instead of shipping.
 *
 * Every case supplies its own probe. A conformance app's environment URLs are fixtures on reserved
 * TLDs that resolve nowhere, so a real probe would answer from the machine's DNS rather than from
 * anything being asserted; the harness default (`carried`) exists for the same reason.
 *
 * Design: `backend/docs/adr/0062-environment-address-bridge-and-route-proof.md`.
 */
export function registerEnvironmentReachabilityTests(harness: ConformanceHarness): void {
  it('proves the route, publishes the address that carried, and round-trips it on every facade', async () => {
    // The reachability column, end to end through each facade's REAL registry repo (D1 ⇄
    // Drizzle). The provider states two addresses for a name; the first does not carry and the
    // second does, so what the environment publishes is the one that CARRIED rather than the one
    // the provider listed first. That distinction is the whole point: a bridge built from an
    // unproved address is recorded as applied while the tester still fails, which puts the
    // evidence further from the cause than no bridge at all.
    const dialled: string[] = []
    const app = harness.makeApp(undefined, {
      environmentProvider: statedAddressProvider() as unknown as EnvironmentProvider,
      routeProbe: async (req) => {
        dialled.push(req.address ?? req.host)
        return req.address === '10.4.19.23' ? { state: 'carried' } : { state: 'unresolved' }
      },
    })
    const { wsId, exec } = await driveDeployOnly(app)
    const deployStep = exec.steps.find((s) => s.agentKind === 'deployer')!
    expect(deployStep.state).toBe('done')
    // The name first, then the provider's addresses in ITS order, stopping at the one that carried.
    expect(dialled).toEqual(['pr-9.preview.test', '10.4.19.22', '10.4.19.23'])

    const envs = await app.call<EnvironmentHandle[]>('GET', `/workspaces/${wsId}/environments`)
    const env = envs.body!.find((e) => e.url === 'https://pr-9.preview.test')!
    expect(env.reachability?.candidates.map((c) => c.address)).toEqual(['10.4.19.22', '10.4.19.23'])
    expect(env.reachability?.proof).toMatchObject({ state: 'reached', via: '10.4.19.23' })
  })

  it('settles the frame FAILED, naming the layer, when nothing the platform can dial carries', async () => {
    // The disposition the incident asked for: a dead environment is reported in about two minutes
    // by the component that owns provisioning, instead of a tester spending ten and a model budget
    // arriving at a confident diagnosis of the DNS layer. `environment_unreachable` is deliberately
    // not repo-fixable, so the remediation loop stays out of it.
    //
    // Every attempt has to ESTABLISH something for the proof to be a verdict about the
    // environment, so the name resolves nowhere and each stated address is dialled and answers
    // nothing. A probe reporting `unresolved` for a literal address would be a malfunction of the
    // probe (`probe_failed`), which is an admission about the platform and settles no frame.
    const app = harness.makeApp(undefined, {
      environmentProvider: statedAddressProvider() as unknown as EnvironmentProvider,
      routeProbe: async (req) => (req.address ? { state: 'no_route' } : { state: 'unresolved' }),
    })
    const { exec } = await driveDeployOnly(app)
    expect(exec.status).toBe('failed')
    expect(exec.failure?.kind).toBe('environment')
    expect(exec.failure?.detail).toContain('resolves nowhere')
    expect(exec.failure?.reason).toBe('environment_unreachable')
  })

  it('keeps the addresses a provider stated ONCE, across every readiness poll', async () => {
    // The async shape this feature exists for, and the one that turned it into a hard failure: a
    // provider states its balancer list on the CREATE response and answers `{state, url}` from its
    // status endpoint. Re-deriving reachability from each poll erased the candidate list before the
    // proof ever ran, so the proof dialled only the name it already knows resolves nowhere and the
    // deployer settled the frame FAILED. Absent is not empty.
    //
    // Cross-runtime because the erasure went through each facade's own registry `update`: a repo
    // that writes the column on every patch diverges here instead of shipping.
    const dialled: string[] = []
    let reads = 0
    const app = harness.makeApp(undefined, {
      environmentProvider: {
        provision: async () => ({
          externalId: 'pr-9',
          status: 'provisioning',
          url: null,
          addresses: [{ address: '10.4.19.22' }, { address: '10.4.19.23', label: 'public ALB' }],
          expiresAt: null,
          access: null,
          fields: {},
        }),
        // Every later answer states nothing about addresses, which is what a narrower status
        // endpoint does. It must not be read as "the provider now states none".
        status: async () =>
          reads++ === 0
            ? { externalId: 'pr-9', status: 'provisioning', url: null, fields: {} }
            : {
                externalId: 'pr-9',
                status: 'ready',
                url: 'https://pr-9.preview.test',
                expiresAt: null,
                access: null,
                fields: {},
              },
        teardown: async () => ({ status: 'torn_down' }),
      } as unknown as EnvironmentProvider,
      routeProbe: async (req) => {
        dialled.push(req.address ?? req.host)
        return req.address === '10.4.19.23' ? { state: 'carried' } : { state: 'unresolved' }
      },
    })
    const { wsId, exec } = await driveDeployOnly(app)
    expect(exec.steps.find((s) => s.agentKind === 'deployer')?.state).toBe('done')
    expect(dialled).toEqual(['pr-9.preview.test', '10.4.19.22', '10.4.19.23'])

    const envs = await app.call<EnvironmentHandle[]>('GET', `/workspaces/${wsId}/environments`)
    const env = envs.body!.find((e) => e.url === 'https://pr-9.preview.test')!
    expect(env.reachability?.candidates.map((c) => c.address)).toEqual(['10.4.19.22', '10.4.19.23'])
    expect(env.reachability?.proof).toMatchObject({ state: 'reached', via: '10.4.19.23' })
  })

  it('ADVANCES the frame when the probe could not tell, and records that it could not', async () => {
    // The disposition that keeps the diagnostic from becoming a second way for a healthy deploy to
    // die. `probe_failed` is where a workerd connect message matching none of that facade's markers
    // and a Node errno outside the mapped five both land, so grading it as a verdict about the
    // environment fails runs on a wording change. The proof still records what happened, detail and
    // all, because "we could not tell" with nothing behind it is not a diagnostic either.
    const app = harness.makeApp(undefined, {
      environmentProvider: statedAddressProvider() as unknown as EnvironmentProvider,
      routeProbe: async () => ({ state: 'failed', detail: 'connect blocked by the runtime' }),
    })
    const { wsId, exec } = await driveDeployOnly(app)
    expect(exec.steps.find((s) => s.agentKind === 'deployer')?.state).toBe('done')
    expect(exec.failure ?? null).toBeNull()

    const envs = await app.call<EnvironmentHandle[]>('GET', `/workspaces/${wsId}/environments`)
    const env = envs.body!.find((e) => e.url === 'https://pr-9.preview.test')!
    expect(env.reachability?.proof).toMatchObject({ state: 'inconclusive', reason: 'probe_failed' })
    expect(env.reachability?.proof?.attempts[0]).toMatchObject({
      detail: 'connect blocked by the runtime',
    })
  })
  it('resolves a stated NAME at proof time and stores the address it carried on, with the name', async () => {
    // The shape a provider fronted by a managed load balancer actually has: its stable identity is
    // a DNS name, and the addresses behind it rotate as the balancer scales. Resolving here rather
    // than in the provider is what stops a stored candidate being a snapshot re-pinned on every
    // poll, and it is what lets the fold keep a proof across a scale event.
    //
    // Cross-runtime because the whole round trip is: the candidate is stored as a `host` on each
    // facade's own reachability column, and `viaHost` beside `via` is a new field on that same
    // blob. A facade mapping either differently diverges here.
    const dialled: string[] = []
    const looked: string[] = []
    const app = harness.makeApp(undefined, {
      environmentProvider: statedHostProvider() as unknown as EnvironmentProvider,
      hostResolver: async (req) => {
        looked.push(req.host)
        return { state: 'resolved', addresses: ['10.4.19.22', '10.4.19.23'] }
      },
      routeProbe: async (req) => {
        dialled.push(req.address ?? req.host)
        return req.address === '10.4.19.23' ? { state: 'carried' } : { state: 'unresolved' }
      },
    })
    const { wsId, exec } = await driveDeployOnly(app)
    expect(exec.steps.find((s) => s.agentKind === 'deployer')?.state).toBe('done')
    expect(looked).toEqual(['alb-4.elb.preview.test'])
    // The URL's own name first, then the addresses the stated NAME resolved to, in order.
    expect(dialled).toEqual(['pr-9.preview.test', '10.4.19.22', '10.4.19.23'])

    const envs = await app.call<EnvironmentHandle[]>('GET', `/workspaces/${wsId}/environments`)
    const env = envs.body!.find((e) => e.url === 'https://pr-9.preview.test')!
    // The stored candidate is the NAME, never the addresses it happened to answer with today.
    expect(env.reachability?.candidates).toEqual([
      { host: 'alb-4.elb.preview.test', label: 'public ALB' },
    ])
    expect(env.reachability?.proof).toMatchObject({
      state: 'reached',
      via: '10.4.19.23',
      viaHost: 'alb-4.elb.preview.test',
    })
  })

  it('rules a stated name OUT when it resolves nowhere, and keeps the name as the candidate', async () => {
    // A retired balancer is a dead end for that candidate and a verdict the proof may settle on,
    // so this environment really is unreachable and the frame fails naming the layer. What the
    // facades can get wrong is the round trip either side of it: the stored candidate stays the
    // NAME (never the addresses it did not answer with), and the attempt names the name it looked
    // up rather than reporting an environment whose provider stated nothing.
    const app = harness.makeApp(undefined, {
      environmentProvider: statedHostProvider() as unknown as EnvironmentProvider,
      hostResolver: async () => ({ state: 'unresolved' }),
      routeProbe: async () => ({ state: 'unresolved' }),
    })
    const { wsId, exec } = await driveDeployOnly(app)
    expect(exec.status).toBe('failed')
    expect(exec.failure?.reason).toBe('environment_unreachable')

    const envs = await app.call<EnvironmentHandle[]>('GET', `/workspaces/${wsId}/environments`)
    const env = envs.body!.find((e) => e.url === 'https://pr-9.preview.test')!
    expect(env.reachability?.candidates).toEqual([
      { host: 'alb-4.elb.preview.test', label: 'public ALB' },
    ])
    expect(env.reachability?.proof).toMatchObject({ state: 'not_reached' })
    expect(env.reachability?.proof?.attempts.map((a) => a.target)).toEqual([
      'pr-9.preview.test:443',
      'pr-9.preview.test@alb-4.elb.preview.test:443',
    ])
  })
}

/**
 * A synchronous provider whose environment comes up `ready` on a name whose per-environment record
 * resolves nowhere, fronted by a balancer the provider identifies by NAME. The half of the
 * motivating shape an address list cannot express: the balancer's addresses rotate and its name is
 * the stable identity its vendor documents.
 */
function statedHostProvider() {
  const provisioned = {
    externalId: 'pr-9',
    url: 'https://pr-9.preview.test',
    addresses: [{ host: 'alb-4.elb.preview.test', label: 'public ALB' }],
    status: 'ready',
    expiresAt: null,
    access: null,
    fields: {},
  }
  return {
    provision: async () => provisioned,
    status: async () => provisioned,
    teardown: async () => ({ status: 'torn_down' }),
  }
}

/**
 * A synchronous provider whose environment comes up `ready` on a name that states two addresses,
 * in its own preference order. The shape this feature exists for: the per-environment DNS record
 * lives in a view the deployment cannot see, while the balancers fronting it are ordinary hosts.
 */
function statedAddressProvider() {
  const provisioned = {
    externalId: 'pr-9',
    url: 'https://pr-9.preview.test',
    addresses: [
      { address: '10.4.19.22', label: 'internal ALB' },
      { address: '10.4.19.23', label: 'public ALB' },
    ],
    status: 'ready',
    expiresAt: null,
    access: null,
    fields: {},
  }
  return {
    provision: async () => provisioned,
    status: async () => provisioned,
    teardown: async () => ({ status: 'torn_down' }),
  }
}

/**
 * Register the manifest connection, seed a deploy-only pipeline and drive one run of it. Shared by
 * the reachability cases, which differ only in what their probe says.
 */
async function driveDeployOnly(
  app: ConformanceApp,
): Promise<{ wsId: string; exec: ExecutionInstance }> {
  const { workspace } = await app.createWorkspace()
  const wsId = workspace.id
  const registered = await app.call('POST', `/workspaces/${wsId}/environments/connection`, {
    config: {
      kind: 'manifest',
      manifest: {
        providerId: 'acme-k8s',
        label: 'Acme Kubernetes',
        baseUrl: 'https://k8s.test/api',
        auth: { type: 'bearer', secretRef: { key: 'API_TOKEN' } },
        provision: { method: 'POST', pathTemplate: '/environments' },
        response: { urlPath: 'url', statusPath: 'state', externalIdPath: 'id' },
      },
    },
    secrets: { API_TOKEN: 'super-secret-env-token' },
  })
  expect(registered.status).toBe(201)
  const pipelineId = await seedLegacyPipeline(app, wsId, {
    id: 'pl_deploy_only',
    name: 'Deploy only',
    purpose: 'build',
    agentKinds: ['deployer'],
  })
  const start = await app.call<ExecutionInstance>(
    'POST',
    `/workspaces/${wsId}/blocks/task_login/executions`,
    { pipelineId },
  )
  expect(start.status).toBe(201)
  return { wsId, exec: (await app.drive(wsId)).find((e) => e.blockId === 'task_login')! }
}
