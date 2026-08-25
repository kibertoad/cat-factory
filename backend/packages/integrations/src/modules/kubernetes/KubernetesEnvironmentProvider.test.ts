import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  KubernetesEnvironmentConfig,
  KubernetesProvisionConfig,
  RecipeStepLog,
  RepoFiles,
  RunRepoContext,
} from '@cat-factory/kernel'
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
    async deleteBranch() {},
    async commitFiles() {
      return { sha: 'c' }
    },
    async openPullRequest() {
      return { number: 1 } as never
    },
  }
  return { repo, baseBranch: 'main', repoId: 'repo_1' }
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
    expect(apply.contentType).toBe('application/apply-patch+yaml')
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

  it('refuses a wildcard-DNS URL that would resolve to another network', async () => {
    // The exact pairing that lost a run: a namespace ending in `-<pullNumber>` in front of the
    // loopback nip.io host, which answers 5.127.0.0. Nothing downstream can notice, because the
    // workloads are healthy and readiness is workload readiness, so the refusal has to be here.
    stubFetch(() => ({ status: 200 }))
    const misresolving = kubernetesConfigToManifest({
      ...config,
      namespaceTemplate: 'cf-acc-{{pullNumber}}',
      url: {
        source: 'ingressTemplate',
        hostTemplate: '{{namespace}}.127.0.0.1.nip.io',
        scheme: 'http',
      },
    })
    await expect(
      new KubernetesEnvironmentProvider().provision({
        manifest: misresolving,
        inputs: { pullNumber: '5', branch: 'feat' },
        resolveSecret,
        runRepo: runRepo({ 'k8s/app.yaml': DEPLOY_YAML }),
      }),
    ).rejects.toThrow(/5\.127\.0\.0/)
  })

  it('classifies that refusal as config_incomplete, so no fixer edits the checkout', async () => {
    // The manifests are correct; the workspace connection is not. Sending a `deploy-fixer` at
    // this would mean hard-coding an address the platform was supposed to substitute.
    stubFetch(() => ({ status: 200 }))
    const misresolving = kubernetesConfigToManifest({
      ...config,
      namespaceTemplate: 'cf-acc-{{pullNumber}}',
      url: {
        source: 'ingressTemplate',
        hostTemplate: '{{namespace}}.127.0.0.1.nip.io',
        scheme: 'http',
      },
    })
    const error = await new KubernetesEnvironmentProvider()
      .provision({
        manifest: misresolving,
        inputs: { pullNumber: '5', branch: 'feat' },
        resolveSecret,
        runRepo: runRepo({ 'k8s/app.yaml': DEPLOY_YAML }),
      })
      .catch((e: unknown) => e)
    expect((error as { details?: { reason?: string } }).details?.reason).toBe('config_incomplete')
  })

  it('provisions normally when the same cluster is addressed by a letter-terminated namespace', async () => {
    // The control for the two above: one character different in the namespace template, and the
    // name carries exactly one address again.
    stubFetch(() => ({ status: 200 }))
    const fixed = kubernetesConfigToManifest({
      ...config,
      namespaceTemplate: 'cf-acc-pr{{pullNumber}}',
      url: {
        source: 'ingressTemplate',
        hostTemplate: '{{namespace}}.127.0.0.1.nip.io',
        scheme: 'http',
      },
    })
    const result = await new KubernetesEnvironmentProvider().provision({
      manifest: fixed,
      inputs: { pullNumber: '5', branch: 'feat' },
      resolveSecret,
      runRepo: runRepo({ 'k8s/app.yaml': DEPLOY_YAML }),
    })
    expect(result.url).toBe('http://cf-acc-pr5.127.0.0.1.nip.io')
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

  it.each([401, 403])(
    'throws on a %d status read (credential/RBAC error) instead of reporting provisioning',
    async (status) => {
      stubFetch((c) =>
        c.method === 'GET' && c.url.includes('/deployments')
          ? { status, body: { message: 'forbidden' } }
          : { status: 200 },
      )
      const provider = new KubernetesEnvironmentProvider()
      await expect(
        provider.status({
          manifest,
          externalId: 'cf-env-1',
          provisionFields: { namespace: 'cf-env-1' },
          resolveSecret,
        }),
      ).rejects.toThrow(/ServiceAccount token|RBAC|HTTP (401|403)/i)
    },
  )

  it('keeps polling (provisioning) on a transient 5xx status read', async () => {
    stubFetch((c) =>
      c.method === 'GET' && c.url.includes('/deployments') ? { status: 503 } : { status: 200 },
    )
    const provider = new KubernetesEnvironmentProvider()
    const result = await provider.status({
      manifest,
      externalId: 'cf-env-1',
      provisionFields: { namespace: 'cf-env-1' },
      resolveSecret,
    })
    expect(result.status).toBe('provisioning')
  })

  it('re-derives an ingress-template URL identically across status (non-branch vars survive)', async () => {
    // provision() must persist the full var set so a hostTemplate referencing {{pullNumber}}
    // (or any non-branch var) is not silently corrupted to an empty value on the next poll.
    const cfg: KubernetesEnvironmentConfig = {
      ...config,
      namespaceTemplate: 'cf-env-{{pullNumber}}',
      url: {
        source: 'ingressTemplate',
        hostTemplate: 'pr-{{pullNumber}}.preview.example.com',
        scheme: 'https',
      },
    }
    const m = kubernetesConfigToManifest(cfg)
    stubFetch((c) =>
      c.method === 'GET' && c.url.includes('/deployments')
        ? { body: { items: [{ spec: { replicas: 1 }, status: { availableReplicas: 1 } }] } }
        : { status: 200 },
    )
    const provider = new KubernetesEnvironmentProvider()
    const provisioned = await provider.provision({
      manifest: m,
      inputs: { pullNumber: '42', branch: 'feat' },
      resolveSecret,
      runRepo: runRepo({ 'k8s/app.yaml': DEPLOY_YAML }),
    })
    expect(provisioned.url).toBe('https://pr-42.preview.example.com')
    const refreshed = await provider.status({
      manifest: m,
      externalId: provisioned.externalId,
      provisionFields: provisioned.fields,
      resolveSecret,
    })
    expect(refreshed.url).toBe('https://pr-42.preview.example.com')
  })

  it('reads the only Ingress in the namespace when ingressStatus omits the name', async () => {
    const cfg: KubernetesEnvironmentConfig = {
      ...config,
      url: { source: 'ingressStatus', scheme: 'https' },
    }
    const m = kubernetesConfigToManifest(cfg)
    const calls = stubFetch((c) => {
      if (c.method === 'GET' && c.url.includes('/deployments')) {
        return { body: { items: [{ spec: { replicas: 1 }, status: { availableReplicas: 1 } }] } }
      }
      if (c.method === 'GET' && c.url.endsWith('/ingresses')) {
        return {
          body: {
            items: [{ status: { loadBalancer: { ingress: [{ hostname: 'lb.example.com' }] } } }],
          },
        }
      }
      return { status: 200 }
    })
    const provider = new KubernetesEnvironmentProvider()
    const result = await provider.status({
      manifest: m,
      externalId: 'cf-env-1',
      provisionFields: { namespace: 'cf-env-1' },
      resolveSecret,
    })
    expect(result.url).toBe('https://lb.example.com')
    // It listed the Ingress collection (no name segment) instead of giving up with null.
    expect(calls.some((c) => c.method === 'GET' && c.url.endsWith('/ingresses'))).toBe(true)
  })
})

describe('KubernetesEnvironmentProvider.status — Gateway-API URL', () => {
  const ready = { body: { items: [{ spec: { replicas: 1 }, status: { availableReplicas: 1 } }] } }

  it('prefers a concrete Gateway listener hostname over the assigned address (gatewayStatus)', async () => {
    const cfg: KubernetesEnvironmentConfig = {
      ...config,
      url: { source: 'gatewayStatus', gatewayName: 'web-gw', scheme: 'https' },
    }
    const calls = stubFetch((c) => {
      if (c.url.includes('/deployments')) return ready
      if (c.url.endsWith('/gateways/web-gw')) {
        return {
          body: {
            spec: {
              listeners: [{ hostname: '*.wild.example.com' }, { hostname: 'app.example.com' }],
            },
            status: { addresses: [{ value: '203.0.113.5' }] },
          },
        }
      }
      return { status: 200 }
    })
    const result = await new KubernetesEnvironmentProvider().status({
      manifest: kubernetesConfigToManifest(cfg),
      externalId: 'cf-env-1',
      provisionFields: { namespace: 'cf-env-1' },
      resolveSecret,
    })
    expect(result.url).toBe('https://app.example.com')
    expect(calls.some((c) => c.url.endsWith('/gateways/web-gw'))).toBe(true)
  })

  it('falls back to the Gateway assigned address and lists when unnamed (gatewayStatus)', async () => {
    const cfg: KubernetesEnvironmentConfig = {
      ...config,
      url: { source: 'gatewayStatus', scheme: 'http' },
    }
    const calls = stubFetch((c) => {
      if (c.url.includes('/deployments')) return ready
      if (c.url.endsWith('/gateways')) {
        return { body: { items: [{ status: { addresses: [{ value: 'lb.example.net' }] } }] } }
      }
      return { status: 200 }
    })
    const result = await new KubernetesEnvironmentProvider().status({
      manifest: kubernetesConfigToManifest(cfg),
      externalId: 'cf-env-1',
      provisionFields: { namespace: 'cf-env-1' },
      resolveSecret,
    })
    expect(result.url).toBe('http://lb.example.net')
    expect(calls.some((c) => c.url.endsWith('/gateways'))).toBe(true)
  })

  it("uses the HTTPRoute's own hostname (httpRouteStatus)", async () => {
    const cfg: KubernetesEnvironmentConfig = {
      ...config,
      url: { source: 'httpRouteStatus', httpRouteName: 'web-route', scheme: 'https' },
    }
    stubFetch((c) => {
      if (c.url.includes('/deployments')) return ready
      if (c.url.endsWith('/httproutes/web-route')) {
        return { body: { spec: { hostnames: ['route.example.com'] } } }
      }
      return { status: 200 }
    })
    const result = await new KubernetesEnvironmentProvider().status({
      manifest: kubernetesConfigToManifest(cfg),
      externalId: 'cf-env-1',
      provisionFields: { namespace: 'cf-env-1' },
      resolveSecret,
    })
    expect(result.url).toBe('https://route.example.com')
  })

  it("falls back to the parent Gateway's address in its own namespace (httpRouteStatus)", async () => {
    const cfg: KubernetesEnvironmentConfig = {
      ...config,
      url: { source: 'httpRouteStatus', scheme: 'https' },
    }
    const calls = stubFetch((c) => {
      if (c.url.includes('/deployments')) return ready
      if (c.url.endsWith('/httproutes')) {
        return {
          body: {
            items: [{ spec: { parentRefs: [{ name: 'shared-gw', namespace: 'gateways' }] } }],
          },
        }
      }
      if (c.url.endsWith('/namespaces/gateways/gateways/shared-gw')) {
        return { body: { status: { addresses: [{ value: 'gw.example.com' }] } } }
      }
      return { status: 200 }
    })
    const result = await new KubernetesEnvironmentProvider().status({
      manifest: kubernetesConfigToManifest(cfg),
      externalId: 'cf-env-1',
      provisionFields: { namespace: 'cf-env-1' },
      resolveSecret,
    })
    expect(result.url).toBe('https://gw.example.com')
    // It read the parent gateway in the parentRef's namespace, not the route's.
    expect(calls.some((c) => c.url.endsWith('/namespaces/gateways/gateways/shared-gw'))).toBe(true)
  })
})

describe('KubernetesEnvironmentProvider.asyncProvision', () => {
  const kustomizeConfig: KubernetesProvisionConfig = {
    ...config,
    manifestSource: { type: 'colocated', path: 'k8s/overlays/preview', renderer: 'kustomize' },
    url: { source: 'gatewayStatus', scheme: 'https' },
    images: [{ name: 'registry/app', newTagTemplate: '{{branch}}' }],
  }
  const deploy = {
    ref: { runId: 'run-1', jobId: 'job-1' },
    clone: { cloneUrl: 'https://github.com/acme/web.git', ref: 'feat', token: 'gh-tok' },
  }

  it('returns null for a raw source with no render fields (use the REST path)', async () => {
    const job = await new KubernetesEnvironmentProvider().asyncProvision!.buildProvisionJob({
      manifest,
      inputs: { pullNumber: '42', branch: 'feat' },
      resolveSecret,
      deploy,
    })
    expect(job).toBeNull()
  })

  it('builds a deploy job for a kustomize source', async () => {
    const job = await new KubernetesEnvironmentProvider().asyncProvision!.buildProvisionJob({
      manifest: kubernetesConfigToManifest(kustomizeConfig),
      inputs: { pullNumber: '42', branch: 'feat' },
      resolveSecret,
      deploy,
    })
    expect(job).not.toBeNull()
    expect(job!.kind).toBe('deploy')
    expect(job!.ref).toEqual({ runId: 'run-1', jobId: 'job-1' })
    expect(job!.options).toEqual({ image: 'deploy' })
    const spec = job!.spec as Record<string, any>
    expect(spec.source).toEqual({
      cloneUrl: 'https://github.com/acme/web.git',
      ref: 'feat',
      path: 'k8s/overlays/preview',
      renderer: 'kustomize',
    })
    expect(spec.cluster.token).toBe('tok')
    expect(spec.cluster.namespace).toBe('cf-env-42')
    expect(spec.images).toEqual([{ name: 'registry/app', newTag: 'feat' }])
    expect(spec.url).toEqual({ source: 'gatewayStatus', scheme: 'https' })
  })

  it('throws when rendering is needed but no deploy inputs are provided', async () => {
    await expect(
      new KubernetesEnvironmentProvider().asyncProvision!.buildProvisionJob({
        manifest: kubernetesConfigToManifest(kustomizeConfig),
        inputs: { pullNumber: '42', branch: 'feat' },
        resolveSecret,
      }),
    ).rejects.toThrow(/deploy inputs/i)
  })

  it('maps a finished deploy job view into a provisioned environment', () => {
    const provisioned = new KubernetesEnvironmentProvider().asyncProvision!.finalizeProvision(
      {
        state: 'done',
        result: { custom: { namespace: 'cf-env-42', url: 'https://x.example', status: 'ready' } },
      },
      {
        manifest: kubernetesConfigToManifest(kustomizeConfig),
        inputs: { pullNumber: '42', branch: 'feat' },
        resolveSecret,
        deploy,
      },
    )
    expect(provisioned.externalId).toBe('cf-env-42')
    expect(provisioned.url).toBe('https://x.example')
    expect(provisioned.status).toBe('ready')
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

  it('reclaims a namespace whose stored config no longer matches the PROVISIONING contract', async () => {
    // The failure this closes: a stored `providerConfig` is re-parsed on the way out, so drift in
    // a field teardown never reads (here the manifest source and the URL derivation) used to
    // refuse the delete. Nothing later fixes that by itself, so the namespace kept running while
    // every sweep re-failed on the same parse. The reclaim path validates what it USES.
    const drifted = kubernetesConfigToManifest(config)
    drifted.providerConfig = {
      apiServerUrl: config.apiServerUrl,
      label: config.label,
      manifestSource: { type: 'colocated' },
      url: { source: 'someSourceThisBuildDoesNotKnow' },
    }
    const calls = stubFetch(() => ({ status: 200 }))
    const provider = new KubernetesEnvironmentProvider()

    const result = await provider.teardown({
      manifest: drifted,
      externalId: 'cf-env-42',
      provisionFields: { namespace: 'cf-env-42' },
      resolveSecret,
    })

    expect(result.status).toBe('torn_down')
    expect(calls.find((c) => c.method === 'DELETE')?.url).toBe(
      'https://cluster.test:6443/api/v1/namespaces/cf-env-42',
    )
  })

  it('still refuses when the apiserver coordinates themselves are what drifted', async () => {
    // The one field with no safe default: a DELETE aimed at a guessed cluster is worse than a
    // refusal, so this half of the config stays validated.
    const { apiServerUrl: _dropped, ...withoutCluster } = config
    const drifted = kubernetesConfigToManifest(config)
    drifted.providerConfig = { ...withoutCluster }
    stubFetch(() => ({ status: 200 }))
    const provider = new KubernetesEnvironmentProvider()

    await expect(
      provider.teardown({
        manifest: drifted,
        externalId: 'cf-env-42',
        provisionFields: { namespace: 'cf-env-42' },
        resolveSecret,
      }),
    ).rejects.toThrow(/apiServerUrl/)
  })
})

describe('KubernetesEnvironmentProvider.confirmTeardown', () => {
  it('reads the namespace back for a config whose PROVISIONING half drifted', async () => {
    // The probe answers the same question the delete asked, so it has to be answerable for the
    // same configs: a teardown that went through and a proof that came back `unknown` would
    // report a reclaim nobody can verify, purely because of a field neither call reads.
    const drifted = kubernetesConfigToManifest(config)
    drifted.providerConfig = { apiServerUrl: config.apiServerUrl, url: { source: 'gone-variant' } }
    stubFetch(() => ({ status: 404 }))
    const provider = new KubernetesEnvironmentProvider()

    const probe = await provider.confirmTeardown({
      manifest: drifted,
      externalId: 'cf-env-42',
      provisionFields: { namespace: 'cf-env-42' },
      resolveSecret,
    })

    expect(probe.state).toBe('gone')
  })
})

describe('KubernetesEnvironmentProvider registry auth', () => {
  // A cluster on THIS machine, which is what the automatic wiring keys on: k3d, kind, Rancher
  // Desktop and WSL2 k3s all present their apiserver on loopback.
  const localConfig: KubernetesProvisionConfig = {
    ...config,
    apiServerUrl: 'https://127.0.0.1:6443',
  }
  const clone = { cloneUrl: 'https://github.com/acme/web.git', ref: 'feat', token: 'gh-tok' }
  const localInputs = { pullNumber: '42', branch: 'feat', repoOwner: 'acme' }

  /** A provision on the raw path, with the image template pointed at the repo's own GHCR package. */
  function provisionLocal(
    overrides: {
      config?: KubernetesProvisionConfig
      clone?: () => Promise<typeof clone | undefined>
      recordStep?: (log: RecipeStepLog) => Promise<void>
    } = {},
  ) {
    const cfg = overrides.config ?? {
      ...localConfig,
      imageTemplate: 'ghcr.io/{{repoOwner}}/web:pr-{{pullNumber}}',
    }
    return new KubernetesEnvironmentProvider().provision({
      manifest: kubernetesConfigToManifest(cfg),
      inputs: localInputs,
      resolveSecret,
      runRepo: runRepo({ 'k8s/app.yaml': DEPLOY_YAML }),
      clone: overrides.clone ?? (async () => clone),
      ...(overrides.recordStep ? { recordStep: overrides.recordStep } : {}),
    })
  }

  /** The pull-secret + service-account writes, in the order they were issued. */
  function registryWrites(calls: { method: string; url: string; body: string | null }[]) {
    return calls.filter((c) => c.url.includes(`fieldManager=cat-factory-registry-auth`))
  }

  it('wires the clone credential into the namespace before the workloads are applied', async () => {
    const calls = stubFetch(() => ({ status: 200 }))
    await provisionLocal()

    const writes = registryWrites(calls)
    expect(writes.map((c) => c.url.split('?')[0])).toEqual([
      'https://127.0.0.1:6443/api/v1/namespaces/cf-env-42/secrets/cat-factory-registry-auth',
      'https://127.0.0.1:6443/api/v1/namespaces/cf-env-42/serviceaccounts/default',
    ])
    const secret = JSON.parse(writes[0]!.body!)
    expect(secret.type).toBe('kubernetes.io/dockerconfigjson')
    expect(JSON.parse(atob(secret.data['.dockerconfigjson'])).auths['ghcr.io']).toEqual({
      username: 'acme',
      password: 'gh-tok',
      auth: btoa('acme:gh-tok'),
    })

    // Ordering is the point: a Deployment's pods are created moments after it applies, so a
    // secret written afterwards costs an ImagePullBackOff cycle on every fresh environment.
    const deploymentApply = calls.findIndex((c) => c.url.includes('/deployments/web'))
    const lastRegistryWrite = calls.lastIndexOf(writes[writes.length - 1]!)
    expect(lastRegistryWrite).toBeLessThan(deploymentApply)
  })

  it('leaves a remote cluster alone, and says so rather than passing over in silence', async () => {
    // The gate that keeps this a local-dev convenience: pushing a git credential into every
    // per-PR namespace is right for a cluster that gets thrown away and is not a decision to
    // make implicitly against a shared one. It still earns a log line, because a silent skip and
    // a wired credential look identical from an ImagePullBackOff.
    const calls = stubFetch(() => ({ status: 200 }))
    const steps: RecipeStepLog[] = []
    await provisionLocal({
      // The shared-cluster shape: `config` reaches its apiserver at cluster.test, not loopback.
      config: { ...config, imageTemplate: 'ghcr.io/{{repoOwner}}/web:pr-{{pullNumber}}' },
      recordStep: async (log) => void steps.push(log),
    })
    expect(registryWrites(calls)).toEqual([])
    expect(steps).toHaveLength(1)
    expect(steps[0]!.detail).toContain('cluster.test')
    expect(steps[0]!.detail).toContain('not on this machine')
  })

  it('does not mint a git token for a provision no image could use one for', async () => {
    // The port documents the clone thunk as LAZY so only a provider that needs a checkout pays
    // the mint. Resolving it before knowing whether any image names a registry made every local
    // provision mint one, including the ones that then wire nothing.
    let mints = 0
    stubFetch(() => ({ status: 200 }))
    await provisionLocal({
      config: { ...localConfig, imageTemplate: 'postgres:16' },
      clone: async () => {
        mints += 1
        return clone
      },
    })
    expect(mints).toBe(0)
  })

  it('writes nothing, and says so, when no credential covers the image', async () => {
    // "Absent" and "wired" must not read the same in the log: an unauthenticated pull is the
    // normal case AND what a private package looks like right up until the kubelet 403s.
    const calls = stubFetch(() => ({ status: 200 }))
    const steps: RecipeStepLog[] = []
    await provisionLocal({
      config: { ...localConfig, imageTemplate: 'postgres:16' },
      recordStep: async (log) => void steps.push(log),
    })
    expect(registryWrites(calls)).toEqual([])
    expect(steps).toHaveLength(1)
    expect(steps[0]!.outcome).toBe('success')
    expect(steps[0]!.detail).toContain('No registry credential wired')
    expect(steps[0]!.detail).toContain('postgres:16')
  })

  it('records what it wired, naming the registry and never the token', async () => {
    stubFetch(() => ({ status: 200 }))
    const steps: RecipeStepLog[] = []
    await provisionLocal({ recordStep: async (log) => void steps.push(log) })
    expect(steps[0]!.detail).toContain('ghcr.io')
    expect(steps[0]!.detail).toContain('package-read scope')
    expect(JSON.stringify(steps)).not.toContain('gh-tok')
  })

  it('provisions anyway when the cluster refuses the pull secret, and reports the cause', async () => {
    // Best-effort by design: a deployment whose packages are already public pulls fine without
    // any of this, so a refused write must not fail a provision that would have succeeded.
    const calls = stubFetch((c) =>
      c.url.includes('/secrets/cat-factory-registry-auth') ? { status: 403 } : { status: 200 },
    )
    const steps: RecipeStepLog[] = []
    const result = await provisionLocal({ recordStep: async (log) => void steps.push(log) })

    expect(result.status).toBe('provisioning')
    expect(calls.some((c) => c.url.includes('/deployments/web'))).toBe(true)
    expect(steps[0]!.outcome).toBe('failure')
    expect(steps[0]!.error).toContain('403')
  })

  it('attaches the credential to the accounts the manifests name, not just the default', async () => {
    const calls = stubFetch(() => ({ status: 200 }))
    await new KubernetesEnvironmentProvider().provision({
      manifest: kubernetesConfigToManifest({
        ...localConfig,
        imageTemplate: 'ghcr.io/acme/web:pr-{{pullNumber}}',
      }),
      inputs: localInputs,
      resolveSecret,
      runRepo: runRepo({
        'k8s/app.yaml': DEPLOY_YAML.replace(
          '    spec:\n',
          '    spec:\n      serviceAccountName: web-sa\n',
        ),
      }),
      clone: async () => clone,
    })
    const accounts = registryWrites(calls)
      .filter((c) => c.url.includes('/serviceaccounts/'))
      .map((c) => c.url.split('/serviceaccounts/')[1]!.split('?')[0])
    expect(accounts).toEqual(['default', 'web-sa'])
  })

  it('folds the secret into an account the manifests DECLARE, rather than racing their apply', async () => {
    // `ServiceAccount.imagePullSecrets` is an ATOMIC list: server-side apply gives the whole list
    // to one field manager, so a separate-manager patch beside the manifests' own apply is not a
    // merge, it is a race that `force=true` settles for whoever writes last. The account the
    // manifests declare therefore carries the entry inside THEIR body, applied once, and this
    // module patches only what nothing else writes.
    const calls = stubFetch(() => ({ status: 200 }))
    await new KubernetesEnvironmentProvider().provision({
      manifest: kubernetesConfigToManifest({
        ...localConfig,
        imageTemplate: 'ghcr.io/acme/web:pr-{{pullNumber}}',
      }),
      inputs: localInputs,
      resolveSecret,
      runRepo: runRepo({
        'k8s/app.yaml':
          `apiVersion: v1\nkind: ServiceAccount\nmetadata:\n  name: web-sa\n` +
          `imagePullSecrets:\n  - name: vendor-creds\n---` +
          DEPLOY_YAML.replace('    spec:\n', '    spec:\n      serviceAccountName: web-sa\n'),
      }),
      clone: async () => clone,
    })

    // Nothing under this module's manager touches the declared account: that write is the one
    // the manifests' later apply would have erased.
    const patched = registryWrites(calls)
      .filter((c) => c.url.includes('/serviceaccounts/'))
      .map((c) => c.url.split('/serviceaccounts/')[1]!.split('?')[0])
    expect(patched).toEqual(['default'])

    // The manifests' own apply carries the union, with the credential the repo already declared
    // kept: replacing it would trade one broken pull for another.
    const declaredApply = calls.find(
      (c) =>
        c.url.includes('/serviceaccounts/web-sa') && c.url.includes('fieldManager=cat-factory&'),
    )
    expect(JSON.parse(declaredApply!.body!).imagePullSecrets).toEqual([
      { name: 'vendor-creds' },
      { name: 'cat-factory-registry-auth' },
    ])
  })

  /** A container-render provision, whose manifests the backend never sees. */
  function buildContainerJob(cfg: Partial<KubernetesProvisionConfig>, steps: RecipeStepLog[]) {
    const base: KubernetesProvisionConfig = {
      ...localConfig,
      manifestSource: { type: 'colocated', path: 'k8s/overlays/preview', renderer: 'kustomize' },
      images: [{ name: 'app', newNameTemplate: 'ghcr.io/acme/web' }],
      ...cfg,
    } as KubernetesProvisionConfig
    // An overlay that keeps its own namespace is spelled by the ABSENCE of the template, so the
    // fixture's default has to come off rather than be overridden with undefined.
    if (cfg.namespaceTemplate === undefined)
      delete (base as { namespaceTemplate?: string }).namespaceTemplate
    return new KubernetesEnvironmentProvider().asyncProvision!.buildProvisionJob({
      manifest: kubernetesConfigToManifest(base),
      inputs: localInputs,
      resolveSecret,
      deploy: { ref: { runId: 'run-1', jobId: 'job-1' }, clone },
      clone: async () => clone,
      recordStep: async (log) => void steps.push(log),
    })
  }

  it('prepares the namespace and its credential before handing over a container render', async () => {
    // Both render paths must behave the same way about a private registry. The container cannot
    // do this for itself: it holds no platform credential to create a Secret with. The namespace
    // template is what makes the destination knowable before dispatch.
    const calls = stubFetch(() => ({ status: 200 }))
    const steps: RecipeStepLog[] = []
    const job = await buildContainerJob({ namespaceTemplate: 'preview-{{pullNumber}}' }, steps)

    expect(job).not.toBeNull()
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/api/v1/namespaces'))).toBe(
      true,
    )
    expect(registryWrites(calls).map((c) => c.url.split('?')[0])).toEqual([
      'https://127.0.0.1:6443/api/v1/namespaces/preview-42/secrets/cat-factory-registry-auth',
      'https://127.0.0.1:6443/api/v1/namespaces/preview-42/serviceaccounts/default',
    ])
    // The honest limit of this path, stated where an operator reads it: the manifests render in
    // the container, so the accounts they declare cannot be enumerated here.
    expect(steps[0]!.detail).toContain('default service account only')
  })

  it('writes nothing when the overlay, not the backend, chooses the namespace', async () => {
    // A kustomize overlay with no namespace template keeps its OWN namespace, which the harness
    // reads back from the built manifests inside the container. Pre-creating the backend's guess
    // would leave an empty namespace nothing ever tears down, and put the credential where no
    // pod reads it, under a log line reporting success.
    const calls = stubFetch(() => ({ status: 200 }))
    const steps: RecipeStepLog[] = []
    const job = await buildContainerJob({}, steps)

    expect(job).not.toBeNull()
    expect(calls).toEqual([])
    expect(steps).toHaveLength(1)
    expect(steps[0]!.detail).toContain('declares its own namespace')
  })

  it('blames the remote cluster, not the overlay, when both would skip', async () => {
    // Ordering between the two skips: on a shared cluster the namespace question never arises,
    // so naming the overlay would send a reader to change a configuration detail that would not
    // have made any difference.
    stubFetch(() => ({ status: 200 }))
    const steps: RecipeStepLog[] = []
    await buildContainerJob({ apiServerUrl: 'https://cluster.test:6443' }, steps)
    expect(steps[0]!.detail).toContain('not on this machine')
  })

  it('hands the render over even when the apiserver refuses the namespace', async () => {
    // The regression this guards: creating the namespace early is a convenience for the
    // credential, and the deploy container creates it itself either way. An apiserver blip, or a
    // service account without namespace-create RBAC, must not fail a provision that succeeded
    // before any of this existed.
    stubFetch((c) => (c.url.endsWith('/api/v1/namespaces') ? { status: 403 } : { status: 200 }))
    const steps: RecipeStepLog[] = []
    const job = await buildContainerJob({ namespaceTemplate: 'preview-{{pullNumber}}' }, steps)

    expect(job).not.toBeNull()
    expect(steps[0]!.outcome).toBe('failure')
    expect(steps[0]!.error).toContain('403')
  })
})
