import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KubernetesEnvironmentConfig } from '@cat-factory/kernel'
import { KubernetesApiClient } from './KubernetesApiClient.js'
import {
  describeKubernetesEnvironment,
  restartKubernetesWorkloads,
} from './kubernetes-diagnostics.js'

// The diagnosis is a fan of independent apiserver reads over a stubbed `fetch`. What is under test
// is what it says when a read DOESN'T answer: an investigation shown a namespace with no facts and
// no explanation concludes the workload was never applied, which is the opposite of an RBAC refusal.

const config: KubernetesEnvironmentConfig = {
  label: 'k3s',
  apiServerUrl: 'https://cluster.test:6443',
  namespaceTemplate: 'cf-env-{{pullNumber}}',
  manifestSource: { type: 'colocated', path: 'k8s/app.yaml' },
  url: { source: 'ingressTemplate', hostTemplate: '{{branch}}.example.com', scheme: 'https' },
}

const resolveSecret = (key: string) => (key === 'apiToken' ? 'tok' : undefined)

interface Route {
  match: (url: string, method: string) => boolean
  status?: number
  body?: unknown
  text?: string
}

function stubFetch(routes: Route[]): { url: string; method: string }[] {
  const calls: { url: string; method: string }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString()
      const method = (init?.method ?? 'GET').toUpperCase()
      calls.push({ url, method })
      const route = routes.find((r) => r.match(url, method))
      if (!route) return new Response('{}', { status: 404 })
      if (route.text !== undefined) {
        return new Response(route.text, {
          status: route.status ?? 200,
          headers: { 'content-type': 'text/plain' },
        })
      }
      return new Response(JSON.stringify(route.body ?? {}), {
        status: route.status ?? 200,
        headers: { 'content-type': 'application/json' },
      })
    }),
  )
  return calls
}

function client() {
  return new KubernetesApiClient(config, resolveSecret)
}

function describeNs() {
  return describeKubernetesEnvironment({ client: client(), config, namespace: 'cf-env-42' })
}

const NAMESPACE_ACTIVE: Route = {
  match: (url, method) => url.endsWith('/api/v1/namespaces/cf-env-42') && method === 'GET',
  body: { status: { phase: 'Active' } },
}
const NO_DEPLOYMENTS: Route = {
  match: (url) => url.includes('/apis/apps/v1/namespaces/cf-env-42/deployments'),
  body: { items: [] },
}
const NO_PODS: Route = {
  match: (url) => url.includes('/api/v1/namespaces/cf-env-42/pods') && !url.includes('/log'),
  body: { items: [] },
}
const NO_EVENTS: Route = {
  match: (url) => url.includes('/api/v1/namespaces/cf-env-42/events'),
  body: { items: [] },
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('describeKubernetesEnvironment', () => {
  it('reports the namespace phase with a verdict, so `Terminating` is visible as unhealthy', async () => {
    stubFetch([
      {
        match: (url) => url.endsWith('/api/v1/namespaces/cf-env-42'),
        body: { status: { phase: 'Terminating' } },
      },
      NO_DEPLOYMENTS,
      NO_PODS,
      NO_EVENTS,
    ])
    const diagnosis = await describeNs()
    expect(diagnosis.facts).toContainEqual({
      key: 'namespace.phase',
      value: 'Terminating',
      healthy: false,
    })
  })

  it("lifts a pod's terminal reason, which `status()` reduces to a bare 'provisioning'", async () => {
    stubFetch([
      NAMESPACE_ACTIVE,
      NO_DEPLOYMENTS,
      {
        match: (url) => url.includes('/api/v1/namespaces/cf-env-42/pods') && !url.includes('/log'),
        body: {
          items: [
            {
              metadata: { name: 'web-abc' },
              status: {
                phase: 'Pending',
                conditions: [{ type: 'Ready', status: 'False' }],
                containerStatuses: [
                  {
                    name: 'app',
                    ready: false,
                    state: {
                      waiting: {
                        reason: 'ImagePullBackOff',
                        message: 'Back-off pulling image "ghcr.io/acme/web:missing"',
                      },
                    },
                  },
                ],
              },
            },
          ],
        },
      },
      NO_EVENTS,
      { match: (url) => url.includes('/pods/web-abc/log'), text: 'boom\nstack trace here' },
    ])
    const diagnosis = await describeNs()
    expect(diagnosis.facts.find((f) => f.key === 'pods.web-abc.terminalReason')?.value).toContain(
      'ImagePullBackOff',
    )
    expect(diagnosis.logs?.[0]).toMatchObject({ source: 'pod/web-abc', truncated: true })
  })

  it('reads the failing container by name so a sidecar does not shadow it', async () => {
    const calls = stubFetch([
      NAMESPACE_ACTIVE,
      NO_DEPLOYMENTS,
      {
        match: (url) => url.includes('/api/v1/namespaces/cf-env-42/pods') && !url.includes('/log'),
        body: {
          items: [
            {
              metadata: { name: 'web-abc' },
              status: {
                phase: 'Running',
                conditions: [{ type: 'Ready', status: 'False' }],
                containerStatuses: [
                  { name: 'sidecar', ready: true, state: { running: {} } },
                  { name: 'app', ready: false, state: { running: {} } },
                ],
              },
            },
          ],
        },
      },
      NO_EVENTS,
      { match: (url) => url.includes('/pods/web-abc/log'), text: 'log line' },
    ])
    await describeNs()
    expect(calls.some((c) => c.url.includes('container=app'))).toBe(true)
  })

  it('states an empty container log as a FACT rather than leaving the section silent', async () => {
    stubFetch([
      NAMESPACE_ACTIVE,
      NO_DEPLOYMENTS,
      {
        match: (url) => url.includes('/api/v1/namespaces/cf-env-42/pods') && !url.includes('/log'),
        body: {
          items: [
            {
              metadata: { name: 'web-abc' },
              status: { phase: 'Pending', conditions: [{ type: 'Ready', status: 'False' }] },
            },
          ],
        },
      },
      NO_EVENTS,
      { match: (url) => url.includes('/pods/web-abc/log'), text: '   ' },
    ])
    const diagnosis = await describeNs()
    expect(diagnosis.facts).toContainEqual({
      key: 'pods.web-abc.log',
      value: 'the container produced no output',
      healthy: false,
    })
  })

  it('records an RBAC refusal as a PERMANENT gap, not as an absence of findings', async () => {
    stubFetch([
      NAMESPACE_ACTIVE,
      { match: (url) => url.includes('/deployments'), status: 403, body: { message: 'forbidden' } },
      NO_PODS,
      NO_EVENTS,
    ])
    const diagnosis = await describeNs()
    const gap = diagnosis.gaps?.find((g) => g.read === 'deployments')
    expect(gap?.permanent).toBe(true)
    expect(gap?.reason).toContain('403')
  })

  it('records a transient failure as a gap that is NOT permanent', async () => {
    stubFetch([
      NAMESPACE_ACTIVE,
      { match: (url) => url.includes('/deployments'), status: 503, body: {} },
      NO_PODS,
      NO_EVENTS,
    ])
    const diagnosis = await describeNs()
    expect(diagnosis.gaps?.find((g) => g.read === 'deployments')?.permanent).toBeUndefined()
  })

  it('keeps reading after one read fails, so a diagnosis survives a partial outage', async () => {
    stubFetch([
      { match: (url) => url.endsWith('/api/v1/namespaces/cf-env-42'), status: 500, body: {} },
      NO_DEPLOYMENTS,
      NO_PODS,
      NO_EVENTS,
    ])
    const diagnosis = await describeNs()
    expect(diagnosis.gaps?.some((g) => g.read === 'namespace')).toBe(true)
    expect(diagnosis.facts.some((f) => f.key === 'deployments.count')).toBe(true)
  })

  it('lists only the Deployment conditions that are NOT satisfied', async () => {
    stubFetch([
      NAMESPACE_ACTIVE,
      {
        match: (url) => url.includes('/deployments'),
        body: {
          items: [
            {
              metadata: { name: 'web' },
              spec: { replicas: 2 },
              status: {
                replicas: 2,
                readyReplicas: 0,
                conditions: [
                  { type: 'Progressing', status: 'True', reason: 'NewReplicaSetAvailable' },
                  {
                    type: 'Available',
                    status: 'False',
                    reason: 'MinimumReplicasUnavailable',
                    message: 'Deployment does not have minimum availability.',
                  },
                ],
              },
            },
          ],
        },
      },
      NO_PODS,
      NO_EVENTS,
    ])
    const diagnosis = await describeNs()
    const keys = diagnosis.facts.map((f) => f.key)
    expect(keys).toContain('deployments.web.condition.Available')
    // A healthy object carries `Progressing=True`; listing it buries the one that says why.
    expect(keys).not.toContain('deployments.web.condition.Progressing')
    expect(diagnosis.facts.find((f) => f.key === 'deployments.web.replicas')?.value).toBe(
      '0/2 ready',
    )
  })
})

describe('restartKubernetesWorkloads', () => {
  it('rolls every Deployment by stamping the pod template, the rollout-restart way', async () => {
    const calls = stubFetch([
      {
        match: (url, method) => url.includes('/deployments') && method === 'GET',
        body: { items: [{ metadata: { name: 'web' } }, { metadata: { name: 'worker' } }] },
      },
      { match: (url, method) => url.includes('/deployments/') && method === 'PATCH', body: {} },
    ])
    const outcome = await restartKubernetesWorkloads({
      client: client(),
      config,
      namespace: 'cf-env-42',
    })
    expect(outcome.applied).toBe(true)
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(2)
  })

  it('reports `applied: false` when there is nothing to roll', async () => {
    // Reporting success would have the engine re-probe an untouched environment and read the
    // unchanged verdict as a remedy that did not work.
    stubFetch([{ match: (url) => url.includes('/deployments'), body: { items: [] } }])
    const outcome = await restartKubernetesWorkloads({
      client: client(),
      config,
      namespace: 'cf-env-42',
    })
    expect(outcome).toMatchObject({ applied: false })
  })

  it('throws when a patch is refused, so nothing waits on a rollout nobody started', async () => {
    stubFetch([
      {
        match: (url, method) => url.includes('/deployments') && method === 'GET',
        body: { items: [{ metadata: { name: 'web' } }] },
      },
      {
        match: (url, method) => url.includes('/deployments/') && method === 'PATCH',
        status: 403,
        body: { message: 'forbidden' },
      },
    ])
    await expect(
      restartKubernetesWorkloads({ client: client(), config, namespace: 'cf-env-42' }),
    ).rejects.toThrow('Failed to restart Deployment/web')
  })
})
