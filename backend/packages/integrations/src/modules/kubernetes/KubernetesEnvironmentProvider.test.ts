import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KubernetesEnvironmentConfig, RepoFiles, RunRepoContext } from '@cat-factory/kernel'
import { KubernetesEnvironmentProvider } from './KubernetesEnvironmentProvider.js'
import { kubernetesConfigToManifest } from './kubernetes-environment.logic.js'

const config: KubernetesEnvironmentConfig = {
  label: 'k3s',
  apiServerUrl: 'https://cluster.test:6443',
  namespaceTemplate: 'cf-env-{{pullNumber}}',
  manifestSource: { type: 'colocated', path: 'k8s/app.yaml' },
  url: {
    source: 'ingressTemplate',
    hostTemplate: '{{branch}}.preview.example.com',
    scheme: 'https',
  },
}
const manifest = kubernetesConfigToManifest(config)
const resolveSecret = (key: string) => (key === 'apiToken' ? 'tok' : undefined)

const DEPLOY_YAML = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 1
  template:
    spec:
      containers:
        - name: app
          image: ghcr.io/acme/web:{{branch}}
`

interface Call {
  method: string
  url: string
  contentType?: string
  body: string | null
}

function stubFetch(handler: (call: Call) => { status?: number; body?: unknown }) {
  const calls: Call[] = []
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    const call: Call = {
      method: (init?.method ?? 'GET').toUpperCase(),
      url: typeof input === 'string' ? input : input.toString(),
      contentType: headers['content-type'],
      body: typeof init?.body === 'string' ? init.body : null,
    }
    calls.push(call)
    const res = handler(call)
    return new Response(JSON.stringify(res.body ?? {}), {
      status: res.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  })
  vi.stubGlobal('fetch', fn)
  return calls
}

function runRepo(files: Record<string, string>): RunRepoContext {
  const repo: RepoFiles = {
    async getFile(path) {
      const content = files[path]
      return content != null ? { content, sha: 'sha' } : null
    },
    async listDirectory() {
      return []
    },
    async headSha() {
      return null
    },
    async createBranch() {},
    async commitFiles() {
      return { sha: 'c' }
    },
    async openPullRequest() {
      return { number: 1 } as never
    },
  }
  return { repo, baseBranch: 'main' }
}

afterEach(() => vi.unstubAllGlobals())

describe('KubernetesEnvironmentProvider.provision', () => {
  it('creates the per-PR namespace, server-side-applies the manifests, and returns the ingress URL', async () => {
    const calls = stubFetch(() => ({ status: 200 }))
    const provider = new KubernetesEnvironmentProvider()
    const result = await provider.provision({
      manifest,
      inputs: { pullNumber: '42', branch: 'feat', blockId: 'blk1' },
      resolveSecret,
      runRepo: runRepo({ 'k8s/app.yaml': DEPLOY_YAML }),
    })

    expect(result.status).toBe('provisioning')
    expect(result.externalId).toBe('cf-env-42')
    expect(result.url).toBe('https://feat.preview.example.com')
    expect(result.fields.namespace).toBe('cf-env-42')

    // Namespace created (idempotent POST), then the Deployment applied via SSA.
    const nsCreate = calls.find((c) => c.method === 'POST' && c.url.endsWith('/api/v1/namespaces'))
    expect(nsCreate).toBeTruthy()
    const apply = calls.find((c) => c.method === 'PATCH')!
    expect(apply.url).toBe(
      'https://cluster.test:6443/apis/apps/v1/namespaces/cf-env-42/deployments/web?fieldManager=cat-factory&force=true',
    )
    expect(apply.contentType).toBe('application/apply-patch+json')
    expect(apply.body).toContain('ghcr.io/acme/web:feat')
    expect(apply.body).toContain('"namespace":"cf-env-42"')
  })

  it('treats a 409 on namespace create as idempotent', async () => {
    stubFetch((c) =>
      c.method === 'POST' && c.url.endsWith('/namespaces') ? { status: 409 } : { status: 200 },
    )
    const provider = new KubernetesEnvironmentProvider()
    const result = await provider.provision({
      manifest,
      inputs: { pullNumber: '7', branch: 'b' },
      resolveSecret,
      runRepo: runRepo({ 'k8s/app.yaml': DEPLOY_YAML }),
    })
    expect(result.status).toBe('provisioning')
  })

  it('reads manifests from a SEPARATE repo when configured', async () => {
    const separate: KubernetesEnvironmentConfig = {
      ...config,
      manifestSource: { type: 'separate', repo: 'acme/infra', ref: 'main', path: 'envs/web.yaml' },
    }
    const calls = stubFetch(() => ({ status: 200 }))
    let resolvedCoords: { owner: string; repo: string } | null = null
    const provider = new KubernetesEnvironmentProvider()
    await provider.provision({
      manifest: kubernetesConfigToManifest(separate),
      inputs: { pullNumber: '1', branch: 'b' },
      resolveSecret,
      resolveRepoFiles: async (coords) => {
        resolvedCoords = { owner: coords.owner, repo: coords.repo }
        return runRepo({ 'envs/web.yaml': DEPLOY_YAML })
      },
    })
    expect(resolvedCoords).toEqual({ owner: 'acme', repo: 'infra' })
    expect(calls.some((c) => c.method === 'PATCH')).toBe(true)
  })

  it('throws when co-located manifests are configured but no run repo is available', async () => {
    stubFetch(() => ({ status: 200 }))
    const provider = new KubernetesEnvironmentProvider()
    await expect(
      provider.provision({ manifest, inputs: { pullNumber: '1' }, resolveSecret }),
    ).rejects.toThrow(/run repo/i)
  })
})

describe('KubernetesEnvironmentProvider.status', () => {
  it('reports ready when the namespace Deployments are rolled out', async () => {
    stubFetch((c) =>
      c.method === 'GET' && c.url.includes('/deployments')
        ? { body: { items: [{ spec: { replicas: 1 }, status: { availableReplicas: 1 } }] } }
        : { status: 200 },
    )
    const provider = new KubernetesEnvironmentProvider()
    const result = await provider.status({
      manifest,
      externalId: 'cf-env-42',
      provisionFields: { namespace: 'cf-env-42', branch: 'feat' },
      resolveSecret,
    })
    expect(result.status).toBe('ready')
    expect(result.url).toBe('https://feat.preview.example.com')
  })

  it('stays provisioning while a Deployment is still rolling out', async () => {
    stubFetch(() => ({
      body: { items: [{ spec: { replicas: 2 }, status: { availableReplicas: 1 } }] },
    }))
    const provider = new KubernetesEnvironmentProvider()
    const result = await provider.status({
      manifest,
      externalId: 'cf-env-1',
      provisionFields: { namespace: 'cf-env-1' },
      resolveSecret,
    })
    expect(result.status).toBe('provisioning')
  })
})

describe('KubernetesEnvironmentProvider.teardown', () => {
  it('deletes the namespace and tolerates a 404', async () => {
    const calls = stubFetch(() => ({ status: 404 }))
    const provider = new KubernetesEnvironmentProvider()
    const result = await provider.teardown({
      manifest,
      externalId: 'cf-env-42',
      provisionFields: { namespace: 'cf-env-42' },
      resolveSecret,
    })
    expect(result.status).toBe('torn_down')
    const del = calls.find((c) => c.method === 'DELETE')!
    expect(del.url).toBe('https://cluster.test:6443/api/v1/namespaces/cf-env-42')
  })
})
