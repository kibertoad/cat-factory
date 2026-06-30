import { describe, expect, it } from 'vitest'
import type { ProvisioningRepoReader } from './provision-detect.logic.js'
import { detectKubernetesProvisioning } from './provision-detect.logic.js'

// In-memory RepoFiles-shaped reader built from a flat path→content map. `listDirectory`
// derives the immediate children (file vs dir) from the keys, mirroring the contents API.
function makeReader(files: Record<string, string>): ProvisioningRepoReader {
  const paths = Object.keys(files)
  return {
    async getFile(path) {
      return path in files ? { content: files[path]! } : null
    },
    async listDirectory(path) {
      const prefix = path ? `${path}/` : ''
      const children = new Map<string, 'file' | 'dir'>()
      for (const full of paths) {
        if (!full.startsWith(prefix)) continue
        const rest = full.slice(prefix.length)
        if (!rest) continue
        const slash = rest.indexOf('/')
        if (slash === -1) children.set(rest, 'file')
        else children.set(rest.slice(0, slash), 'dir')
      }
      return [...children].map(([name, type]) => ({ name, type, path: prefix + name }))
    },
  }
}

const deployment = (image: string) => `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app
spec:
  template:
    spec:
      containers:
        - name: app
          image: ${image}
`

describe('detectKubernetesProvisioning', () => {
  it('detects raw colocated manifests + an Ingress URL source + image overrides', async () => {
    const reader = makeReader({
      'k8s/deployment.yaml': deployment('registry/app:latest'),
      'k8s/ingress.yaml': `
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: app-ingress
spec:
  rules:
    - host: app.preview.example.com
`,
    })
    const rec = await detectKubernetesProvisioning(reader)
    expect(rec.detected).toBe(true)
    expect(rec.provisioning.type).toBe('kubernetes')
    expect(rec.provisioning.manifestSource).toEqual({ type: 'colocated', path: 'k8s' })
    // raw renderer ⇒ no `renderer` field persisted.
    expect(rec.provisioning.manifestSource?.renderer).toBeUndefined()
    expect(rec.urlSource).toEqual({
      source: 'ingressTemplate',
      hostTemplate: 'app.preview.example.com',
    })
    expect(rec.provisioning.images).toEqual([
      { name: 'registry/app', newTagTemplate: '{{branch}}' },
    ])
  })

  it('detects a kustomize overlay tree: renderer, overlay candidates, namespace, secret keys, HTTPRoute URL', async () => {
    const reader = makeReader({
      'k8s/base/kustomization.yaml': `
resources:
  - deployment.yaml
  - route.yaml
`,
      'k8s/base/deployment.yaml': deployment('registry/app:1.0.0'),
      'k8s/base/route.yaml': `
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: app-route
`,
      'k8s/overlays/prod/kustomization.yaml': `
resources:
  - ../../base
namespace: prod
`,
      'k8s/overlays/prenv/kustomization.yaml': `
resources:
  - ../../base
namespace: preview
images:
  - name: registry/app
secretGenerator:
  - name: app-secrets
    envs:
      - .env
`,
      'k8s/overlays/prenv/.env.example': `
# example
DATABASE_URL=
API_KEY=
export FEATURE_FLAG=
`,
    })
    const rec = await detectKubernetesProvisioning(reader)
    expect(rec.provisioning.type).toBe('kubernetes')
    expect(rec.provisioning.manifestSource).toEqual({
      type: 'colocated',
      path: 'k8s/overlays/prenv',
      renderer: 'kustomize',
    })
    // prenv outranks prod for the ephemeral overlay; both surfaced.
    expect(rec.overlayCandidates).toEqual([
      { path: 'k8s/overlays/prenv', name: 'prenv', recommended: true },
      { path: 'k8s/overlays/prod', name: 'prod', recommended: false },
    ])
    expect(rec.namespace).toBe('preview')
    expect(rec.urlSource).toEqual({ source: 'httpRouteStatus', httpRouteName: 'app-route' })
    expect(rec.provisioning.images).toEqual([
      { name: 'registry/app', newTagTemplate: '{{branch}}' },
    ])
    expect(rec.provisioning.secretInjections).toEqual([
      {
        mode: 'generatorEnvFile',
        envFilePath: 'k8s/overlays/prenv/.env',
        entries: [
          { key: 'DATABASE_URL', secretRef: { key: 'DATABASE_URL' } },
          { key: 'API_KEY', secretRef: { key: 'API_KEY' } },
          { key: 'FEATURE_FLAG', secretRef: { key: 'FEATURE_FLAG' } },
        ],
      },
    ])
  })

  it('descends into a nested deployment/k8s wrapper to find the overlay tree', async () => {
    // Mirrors a real repo (kibertoad/simpler-service3): a standard helm/kustomize layout whose
    // manifests live under `deployment/k8s/{base,overlays}` rather than directly in `deployment/`.
    // The `deployment` candidate has no direct kustomize markers, so detection must descend into
    // its `k8s` child instead of bailing out to infraless.
    const reader = makeReader({
      'deployment/README.md': '# how to deploy',
      'deployment/k8s/base/kustomization.yaml': `
namespace: simpler-service3-prenv
resources:
  - namespace.yaml
  - services/app
`,
      'deployment/k8s/base/namespace.yaml': `
apiVersion: v1
kind: Namespace
metadata:
  name: simpler-service3-prenv
`,
      'deployment/k8s/base/services/app/kustomization.yaml': `
resources:
  - deployment.yaml
`,
      'deployment/k8s/base/services/app/deployment.yaml': deployment('registry/app:1.0.0'),
      'deployment/k8s/overlays/prenv/kustomization.yaml': `
resources:
  - ../../base
`,
    })
    const rec = await detectKubernetesProvisioning(reader)
    expect(rec.detected).toBe(true)
    expect(rec.provisioning.type).toBe('kubernetes')
    expect(rec.provisioning.manifestSource).toEqual({
      type: 'colocated',
      path: 'deployment/k8s/overlays/prenv',
      renderer: 'kustomize',
    })
    // The single overlay isn't surfaced as a multi-candidate choice.
    expect(rec.overlayCandidates).toBeUndefined()
    // The base's pinned namespace is followed through the overlay → base ref walk.
    expect(rec.namespace).toBe('simpler-service3-prenv')
    expect(rec.provisioning.images).toEqual([
      { name: 'registry/app', newTagTemplate: '{{branch}}' },
    ])
  })

  it('infers a serviceStatus URL from a LoadBalancer Service', async () => {
    const reader = makeReader({
      'manifests/svc.yaml': `
apiVersion: v1
kind: Service
metadata:
  name: web
spec:
  type: LoadBalancer
  ports:
    - port: 8080
`,
    })
    const rec = await detectKubernetesProvisioning(reader)
    expect(rec.urlSource).toEqual({ source: 'serviceStatus', serviceName: 'web', port: 8080 })
  })

  it('proposes pinned helm releases from a helmfile (low confidence)', async () => {
    const reader = makeReader({
      'k8s/deployment.yaml': deployment('registry/app:1.0.0'),
      'helmfile.yaml': `
releases:
  - name: ingress-nginx
    chart: ingress-nginx/ingress-nginx
    version: 4.11.3
    repo: https://kubernetes.github.io/ingress-nginx
  - name: floating
    chart: foo/bar
    version: latest
`,
    })
    const rec = await detectKubernetesProvisioning(reader)
    expect(rec.provisioning.helmReleases).toEqual([
      {
        name: 'ingress-nginx',
        chart: 'ingress-nginx/ingress-nginx',
        version: '4.11.3',
        repo: 'https://kubernetes.github.io/ingress-nginx',
      },
    ])
    const helmNote = rec.notes.find((n) => n.field === 'helmReleases')
    expect(helmNote?.confidence).toBe('low')
  })

  it('falls back to docker-compose when only a compose file exists', async () => {
    const reader = makeReader({ 'compose.yaml': 'services: {}' })
    const rec = await detectKubernetesProvisioning(reader)
    expect(rec).toEqual({
      detected: true,
      provisioning: { type: 'docker-compose', composePath: 'compose.yaml' },
      notes: [expect.objectContaining({ field: 'provisionType', confidence: 'high' })],
    })
  })

  it('recommends infraless when nothing is detected', async () => {
    const reader = makeReader({ 'README.md': '# hello' })
    const rec = await detectKubernetesProvisioning(reader)
    expect(rec.detected).toBe(false)
    expect(rec.provisioning).toEqual({ type: 'infraless' })
  })

  it('scopes detection to a monorepo service subdirectory', async () => {
    const reader = makeReader({
      'docker-compose.yml': 'services: {}',
      'services/api/k8s/deployment.yaml': deployment('registry/api:1.0.0'),
    })
    const rec = await detectKubernetesProvisioning(reader, { directory: 'services/api' })
    expect(rec.provisioning.type).toBe('kubernetes')
    expect(rec.provisioning.manifestSource).toEqual({
      type: 'colocated',
      path: 'services/api/k8s',
    })
  })

  it('notes a compose file alongside kubernetes manifests without switching the type', async () => {
    const reader = makeReader({
      'docker-compose.yml': 'services: {}',
      'k8s/deployment.yaml': deployment('registry/app:1.0.0'),
    })
    const rec = await detectKubernetesProvisioning(reader)
    expect(rec.provisioning.type).toBe('kubernetes')
    expect(rec.notes.some((n) => n.field === 'compose')).toBe(true)
  })

  it('represents repo-root manifests as a "." path (never an empty, schema-invalid path)', async () => {
    const reader = makeReader({
      'deployment.yaml': deployment('registry/app:1.0.0'),
      'service.yaml': `
apiVersion: v1
kind: Service
metadata:
  name: web
spec:
  type: LoadBalancer
  ports:
    - port: 8080
`,
    })
    const rec = await detectKubernetesProvisioning(reader)
    expect(rec.provisioning.type).toBe('kubernetes')
    // The repo root is the manifest dir; the stored path must be non-empty (schema minLength 1),
    // and the root scan still resolves the LoadBalancer URL + image override.
    expect(rec.provisioning.manifestSource).toEqual({ type: 'colocated', path: '.' })
    expect(rec.urlSource).toEqual({ source: 'serviceStatus', serviceName: 'web', port: 8080 })
    expect(rec.provisioning.images).toEqual([
      { name: 'registry/app', newTagTemplate: '{{branch}}' },
    ])
  })
})
