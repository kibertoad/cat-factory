import type {
  EnvironmentManifest,
  ProvisionedEnvironment,
  RepoFiles,
  RunRepoContext,
} from '@cat-factory/kernel'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { KubernetesEnvironmentProvider } from './KubernetesEnvironmentProvider.js'
import { kubernetesConfigToManifest, resourceUrl } from './kubernetes-environment.logic.js'
import {
  clusterSkipReason,
  deleteNamespaceQuietly,
  envConfig,
  rawClient,
  readClusterEnv,
  tokenResolver,
  uniqueSuffix,
  waitFor,
} from './test-support/cluster.js'

// INTEGRATION: drives KubernetesEnvironmentProvider against a REAL k3d/Kubernetes apiserver.
// k3s ships the klipper ServiceLB, so a `type: LoadBalancer` Service actually gets an address
// — letting us validate the whole apply→roll-out→resolve-URL→teardown path for real: the
// per-PR namespace create (idempotent 409), server-side apply (`apply-patch+json`), real
// Deployment readiness, the `.status.loadBalancer` shape `readLoadBalancerAddress` parses, and
// the idempotent namespace delete. Self-skips when `K8S_IT_*` is unset.

const env = readClusterEnv()
const skip = clusterSkipReason(env)

// An nginx Deployment + a LoadBalancer Service named `web` — the env config resolves the URL
// from this Service's k3s-assigned LoadBalancer address.
const APP_YAML = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 1
  selector:
    matchLabels:
      app: web
  template:
    metadata:
      labels:
        app: web
    spec:
      containers:
        - name: nginx
          image: nginx:1.27-alpine
          ports:
            - containerPort: 80
---
apiVersion: v1
kind: Service
metadata:
  name: web
spec:
  type: LoadBalancer
  selector:
    app: web
  ports:
    - port: 80
      targetPort: 80
`

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

describe.skipIf(skip !== null)(
  `KubernetesEnvironmentProvider (k3d integration)${skip ? ` — ${skip}` : ''}`,
  () => {
    // The cluster env is present whenever this suite is NOT skipped. `describe.skipIf` still
    // runs this callback to collect the tests, so the env-dependent manifest is built in
    // beforeAll (which IS skipped) rather than here, where `env` could still be null.
    const cluster = env as NonNullable<typeof env>
    const provider = new KubernetesEnvironmentProvider()
    const resolveSecret = tokenResolver(cluster)
    let manifest: EnvironmentManifest
    const namespaces: string[] = []

    beforeAll(() => {
      manifest = kubernetesConfigToManifest(envConfig(cluster))
    })

    afterAll(async () => {
      for (const ns of namespaces) await deleteNamespaceQuietly(cluster, ns)
    })

    it('provisions a per-PR namespace, applies the manifests, and resolves the k3s LoadBalancer URL', async () => {
      const blockId = `it-${uniqueSuffix()}`
      const provisioned = await provider.provision({
        manifest,
        inputs: { pullNumber: '1', branch: 'feat', blockId },
        resolveSecret,
        runRepo: runRepo({ 'k8s/app.yaml': APP_YAML }),
      })
      expect(provisioned.status).toBe('provisioning')
      expect(provisioned.externalId).toBeTruthy()
      const namespace = provisioned.externalId!
      namespaces.push(namespace)

      // Re-provision is idempotent (namespace 409 + server-side apply re-converges).
      await expect(
        provider.provision({
          manifest,
          inputs: { pullNumber: '1', branch: 'feat', blockId },
          resolveSecret,
          runRepo: runRepo({ 'k8s/app.yaml': APP_YAML }),
        }),
      ).resolves.toBeTruthy()

      // Poll real status until the Deployment is rolled out AND the klipper LoadBalancer
      // address has been assigned (so the URL resolves).
      const ready = await waitFor<ProvisionedEnvironment>(
        () =>
          provider.status({
            manifest,
            externalId: namespace,
            provisionFields: provisioned.fields,
            resolveSecret,
          }),
        (s) => s.status === 'ready' && !!s.url,
        { timeoutMs: 150_000, intervalMs: 3_000 },
      )
      expect(ready.status).toBe('ready')
      expect(ready.url).toMatch(/^http:\/\/.+:80$/)
    })

    it('resolves the URL from a named Ingress status (ingressStatus source)', async () => {
      // The minimal test cluster runs no Ingress controller (Traefik is disabled so the
      // serviceStatus test can own host port 80), so nothing programs an Ingress' address.
      // We therefore apply a real Ingress through the provider, then set its
      // `.status.loadBalancer` via the apiserver status subresource — exactly the shape a
      // controller would write — and assert the provider GETs that real Ingress and parses
      // the address into the URL. (What's under test is the provider's read+parse of the
      // live apiserver Ingress status, not the controller.)
      const ingressYaml = `
apiVersion: v1
kind: Service
metadata:
  name: web
spec:
  selector:
    app: web
  ports:
    - port: 80
      targetPort: 80
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: web
spec:
  rules:
    - host: web.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: web
                port:
                  number: 80
`
      const config = envConfig(cluster, {
        manifestSource: { type: 'colocated', path: 'k8s/ingress.yaml' },
        url: { source: 'ingressStatus', ingressName: 'web', scheme: 'http' },
      })
      const ingressManifest = kubernetesConfigToManifest(config)
      const provisioned = await provider.provision({
        manifest: ingressManifest,
        inputs: { pullNumber: '3', branch: 'ing', blockId: `it-${uniqueSuffix()}` },
        resolveSecret,
        runRepo: runRepo({ 'k8s/ingress.yaml': ingressYaml }),
      })
      const namespace = provisioned.externalId!
      namespaces.push(namespace)

      // Stand in for the ingress controller: write the LoadBalancer address onto the real
      // Ingress' status subresource (a TEST-NET-3 address, RFC 5737).
      const statusUrl = `${resourceUrl(config, 'networking.k8s.io/v1', 'Ingress', namespace, 'web')}/status`
      const patch = await rawClient(cluster).fetch(
        'PATCH',
        statusUrl,
        { status: { loadBalancer: { ingress: [{ ip: '203.0.113.10' }] } } },
        30_000,
        'application/merge-patch+json',
      )
      expect(patch.ok).toBe(true)

      const ready = await provider.status({
        manifest: ingressManifest,
        externalId: namespace,
        provisionFields: provisioned.fields,
        resolveSecret,
      })
      expect(ready.status).toBe('ready')
      expect(ready.url).toBe('http://203.0.113.10')
    })

    it('tears the namespace down and tolerates a repeat teardown', async () => {
      const blockId = `it-${uniqueSuffix()}`
      const provisioned = await provider.provision({
        manifest,
        inputs: { pullNumber: '2', branch: 'b', blockId },
        resolveSecret,
        runRepo: runRepo({ 'k8s/app.yaml': APP_YAML }),
      })
      const namespace = provisioned.externalId!
      namespaces.push(namespace)

      const first = await provider.teardown({
        manifest,
        externalId: namespace,
        provisionFields: provisioned.fields,
        resolveSecret,
      })
      expect(first.status).toBe('torn_down')

      // A second teardown is idempotent (the namespace is gone / terminating → 404/409 tolerated).
      const second = await provider.teardown({
        manifest,
        externalId: namespace,
        provisionFields: provisioned.fields,
        resolveSecret,
      })
      expect(second.status).toBe('torn_down')
    })
  },
)
