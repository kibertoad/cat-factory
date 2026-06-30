import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { handleDeploy } from '../src/deploy.js'
import type { DeployJob } from '../src/job.js'
import { server } from '../src/server.js'
import {
  buildClusterSpec,
  type ClusterEnv,
  type ClusterKubectl,
  clusterKubectl,
  clusterSkipReason,
  gitRepoWithManifests,
  quietLog,
  readClusterEnv,
  uniqueNamespace,
  waitFor,
} from './cluster.js'

// INTEGRATION: drives the deploy harness's handleDeploy against a REAL k3d/Kubernetes
// apiserver with the REAL kubectl/kustomize CLIs — the same cluster the integrations
// Kubernetes suite uses (`K8S_IT_*`). It validates the things the unit tests can only mock:
// the git clone → namespace → secret write → kustomize edits → kubectl apply → rollout →
// URL-discovery pipeline end to end, the kustomize image/namespace edits + secretGenerator
// name-rewrite (the whole reason this container exists, vs the in-Worker REST adapter), the
// k3s ServiceLB URL resolution, and the slow-rollout / failure behaviours. Self-skips when
// `K8S_IT_*` is unset, mirroring the DATABASE_URL / Docker self-skip pattern.

const env = readClusterEnv()
const skip = clusterSkipReason(env)

// nginx (pre-imported into the CI cluster) Deployment + a `type: LoadBalancer` Service named
// `web` — k3s's klipper ServiceLB assigns the Service an address, so `serviceStatus` resolves.
const RAW_APP_YAML = `
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

// A trivial, fast-to-apply resource (no rollout, no LB) for tests that only exercise the
// harness lifecycle / a side channel rather than a real workload.
const CONFIGMAP_YAML = `
apiVersion: v1
kind: ConfigMap
metadata:
  name: marker
data:
  ok: "true"
`

describe.skipIf(skip !== null)(
  `deploy-harness handleDeploy (k3d integration)${skip ? ` — ${skip}` : ''}`,
  () => {
    // The cluster env is present whenever this suite is NOT skipped; `describe.skipIf` still
    // runs this callback to collect the tests, so the env-dependent setup is in beforeAll.
    const cluster = env as ClusterEnv
    let kubectl: ClusterKubectl
    const namespaces: string[] = []
    const cleanups: Array<() => Promise<void>> = []

    beforeAll(async () => {
      kubectl = await clusterKubectl(cluster)
    })

    afterAll(async () => {
      for (const ns of namespaces) await kubectl.deleteNamespaceQuietly(ns)
      for (const cleanup of cleanups) await cleanup()
    })

    /** Register a manifest git repo + namespace for cleanup, returning the source coordinates. */
    async function source(
      files: Record<string, string>,
      path: string,
      renderer: 'raw' | 'kustomize',
    ): Promise<DeployJob['source']> {
      const repo = await gitRepoWithManifests(files)
      cleanups.push(repo.cleanup)
      return { cloneUrl: repo.cloneUrl, ref: repo.ref, path, renderer }
    }

    function freshNamespace(): string {
      const ns = uniqueNamespace()
      namespaces.push(ns)
      return ns
    }

    it('raw: clones, applies, rolls out, resolves the k3s LoadBalancer URL, and is idempotent', async () => {
      const namespace = freshNamespace()
      const job: DeployJob = {
        jobId: `it-raw-${namespace}`,
        cluster: buildClusterSpec(cluster, namespace),
        source: await source({ 'k8s/app.yaml': RAW_APP_YAML }, 'k8s/app.yaml', 'raw'),
        url: { source: 'serviceStatus', serviceName: 'web', port: 80, scheme: 'http' },
      }

      // Re-running handleDeploy is idempotent (namespace apply is create-or-update, kubectl
      // server-side apply re-converges), so we poll the full flow until the klipper LB address
      // has been assigned and the URL resolves.
      const result = await waitFor(
        () => handleDeploy(job, { log: quietLog }),
        (r) => r.custom?.status === 'ready' && !!r.custom.url,
      )
      expect(result.custom?.status).toBe('ready')
      expect(result.custom?.url).toMatch(/^http:\/\/.+:80$/)

      // The Deployment really rolled out in the per-PR namespace.
      const deploy = (await kubectl.json(['get', 'deploy', 'web', '-n', namespace])) as {
        status?: { availableReplicas?: number }
      }
      expect(deploy.status?.availableReplicas).toBeGreaterThanOrEqual(1)
    })

    it('kustomize: applies the namespace override + image override edits', async () => {
      const namespace = freshNamespace()
      const kustomization = `
resources:
  - deployment.yaml
`
      const deployment = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: kapp
spec:
  replicas: 1
  selector:
    matchLabels:
      app: kapp
  template:
    metadata:
      labels:
        app: kapp
    spec:
      containers:
        - name: nginx
          image: nginx
`
      const job: DeployJob = {
        jobId: `it-kustomize-${namespace}`,
        cluster: buildClusterSpec(cluster, namespace),
        source: await source(
          { 'k8s/kustomization.yaml': kustomization, 'k8s/deployment.yaml': deployment },
          'k8s',
          'kustomize',
        ),
        setNamespace: true,
        images: [{ name: 'nginx', newTag: '1.27-alpine' }],
        url: { source: 'ingressTemplate' },
      }

      const result = await handleDeploy(job, { log: quietLog })
      expect(result.custom?.status).toBe('ready')

      // `kustomize edit set namespace` placed the Deployment in the job namespace, and
      // `kustomize edit set image` rewrote the bare `nginx` to the pinned tag.
      const deploy = (await kubectl.json(['get', 'deploy', 'kapp', '-n', namespace])) as {
        spec?: { template?: { spec?: { containers?: { image?: string }[] } } }
      }
      expect(deploy.spec?.template?.spec?.containers?.[0]?.image).toBe('nginx:1.27-alpine')
    })

    it('secrets: writes a generatorEnvFile (hash-suffixed Secret) and a direct mode:secret Secret', async () => {
      const namespace = freshNamespace()
      // A kustomization with a secretGenerator reading the env file the harness writes — kustomize
      // hashes the content into the Secret name (`<name>-<hash>`), the rewrite the REST adapter
      // can't do. Plus a separate mode:'secret' injection applied directly by the harness.
      const kustomization = `
secretGenerator:
  - name: app-config
    envs:
      - app.env
`
      const job: DeployJob = {
        jobId: `it-secrets-${namespace}`,
        cluster: buildClusterSpec(cluster, namespace),
        source: await source({ 'k8s/kustomization.yaml': kustomization }, 'k8s', 'kustomize'),
        secretInjections: [
          {
            mode: 'generatorEnvFile',
            envFilePath: 'k8s/app.env',
            entries: [{ key: 'TOKEN', value: 's3cr3t-generated' }],
          },
          {
            mode: 'secret',
            secretName: 'app-secrets',
            entries: [{ key: 'API_KEY', value: 'direct-secret-abc' }],
          },
        ],
        url: { source: 'ingressTemplate' },
      }

      const result = await handleDeploy(job, { log: quietLog })
      expect(result.custom?.status).toBe('ready')

      // The generated Secret carries kustomize's content-hash suffix.
      const secrets = (await kubectl.json(['get', 'secrets', '-n', namespace])) as {
        items?: { metadata?: { name?: string }; data?: Record<string, string> }[]
      }
      const generated = secrets.items?.find((s) =>
        /^app-config-[a-z0-9]+$/.test(s.metadata?.name ?? ''),
      )
      expect(generated, 'a hash-suffixed app-config-* Secret should exist').toBeTruthy()
      expect(Buffer.from(generated?.data?.TOKEN ?? '', 'base64').toString('utf8')).toBe(
        's3cr3t-generated',
      )

      // The directly-injected Secret was applied verbatim under its given name.
      const direct = (await kubectl.json(['get', 'secret', 'app-secrets', '-n', namespace])) as {
        data?: Record<string, string>
      }
      expect(Buffer.from(direct.data?.API_KEY ?? '', 'base64').toString('utf8')).toBe(
        'direct-secret-abc',
      )
    })

    it('reports `provisioning` (not failed) when a Deployment never becomes ready', async () => {
      const namespace = freshNamespace()
      // An image that cannot be pulled never rolls out; with a short rollout timeout the harness
      // reports the env as still `provisioning` (the backend keeps polling) rather than failing.
      const stuck = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: stuck
spec:
  replicas: 1
  selector:
    matchLabels:
      app: stuck
  template:
    metadata:
      labels:
        app: stuck
    spec:
      containers:
        - name: app
          image: nginx:does-not-exist-cf-it
`
      const job: DeployJob = {
        jobId: `it-stuck-${namespace}`,
        cluster: buildClusterSpec(cluster, namespace),
        source: await source({ 'k8s/stuck.yaml': stuck }, 'k8s/stuck.yaml', 'raw'),
        url: { source: 'ingressTemplate' },
        rolloutTimeoutSeconds: 5,
      }

      const result = await handleDeploy(job, { log: quietLog })
      expect(result.custom?.status).toBe('provisioning')
    })

    it('rejects on an invalid manifest, with the cluster token scrubbed from the error', async () => {
      const namespace = freshNamespace()
      const job: DeployJob = {
        jobId: `it-bad-${namespace}`,
        cluster: buildClusterSpec(cluster, namespace),
        source: await source(
          { 'k8s/bad.yaml': 'apiVersion: v1\nkind: NotARealKind\nmetadata:\n  name: x\n' },
          'k8s/bad.yaml',
          'raw',
        ),
        url: { source: 'ingressTemplate' },
      }

      let caught: unknown
      await expect(handleDeploy(job, { log: quietLog })).rejects.toThrow(/NotARealKind|no matches/i)
      try {
        await handleDeploy(job, { log: quietLog })
      } catch (err) {
        caught = err
      }
      expect(String(caught)).not.toContain(cluster.token)
    })

    it('serves the full POST /jobs + GET /jobs/{id} contract', async () => {
      const namespace = freshNamespace()
      // Vitest sets NODE_ENV=test, so importing the server module does NOT auto-listen — we bind
      // an ephemeral port here and exercise the same HTTP contract the RunnerTransport drives.
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const { port } = server.address() as AddressInfo
      const baseUrl = `http://127.0.0.1:${port}`
      const repo = await gitRepoWithManifests({ 'k8s/cm.yaml': CONFIGMAP_YAML })
      cleanups.push(repo.cleanup)
      try {
        const jobId = `it-server-${namespace}`
        const body = {
          kind: 'deploy',
          jobId,
          cluster: buildClusterSpec(cluster, namespace),
          source: { cloneUrl: repo.cloneUrl, ref: repo.ref, path: 'k8s/cm.yaml', renderer: 'raw' },
          url: { source: 'ingressTemplate' },
        }
        const started = await fetch(`${baseUrl}/jobs`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
        expect(started.status).toBe(202)
        expect(((await started.json()) as { jobId: string }).jobId).toBe(jobId)

        const view = await waitFor(
          async () =>
            (await fetch(`${baseUrl}/jobs/${jobId}`)).json() as Promise<{
              state: string
              result?: { custom?: { status?: string } }
            }>,
          (v) => v.state === 'done' || v.state === 'failed',
          { timeoutMs: 120_000, intervalMs: 2_000 },
        )
        expect(view.state).toBe('done')
        expect(view.result?.custom?.status).toBe('ready')

        // The applied ConfigMap really landed in the per-PR namespace.
        const cm = (await kubectl.json(['get', 'configmap', 'marker', '-n', namespace])) as {
          data?: { ok?: string }
        }
        expect(cm.data?.ok).toBe('true')
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    })
  },
)
