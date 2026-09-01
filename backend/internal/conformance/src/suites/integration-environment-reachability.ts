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
    const app = harness.makeApp(undefined, {
      environmentProvider: statedAddressProvider() as unknown as EnvironmentProvider,
      routeProbe: async () => ({ state: 'unresolved' }),
    })
    const { exec } = await driveDeployOnly(app)
    expect(exec.status).toBe('failed')
    expect(exec.failure?.kind).toBe('environment')
    expect(exec.failure?.detail).toContain('resolves nowhere')
    expect(exec.failure?.reason).toBe('environment_unreachable')
  })
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
