import { describe, expect, it } from 'vitest'
import type { ProvisioningRepoReader } from './provision-detect.logic.js'
import { detectCustomManifest, detectKubernetesProvisioning } from './provision-detect.logic.js'

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

  it('recommends build-from-source mode when a compose service builds from source', async () => {
    const reader = makeReader({
      'docker-compose.yml': 'services:\n  web:\n    build: .\n  db:\n    image: postgres\n',
    })
    const rec = await detectKubernetesProvisioning(reader)
    expect(rec.provisioning.type).toBe('docker-compose')
    expect(rec.provisioning.composeBuild).toBe(true)
    expect(rec.notes.some((n) => n.field === 'composeBuild')).toBe(true)
  })

  it('does NOT set build mode for an image-only compose stack', async () => {
    const reader = makeReader({
      'docker-compose.yml': 'services:\n  web:\n    image: nginx\n',
    })
    const rec = await detectKubernetesProvisioning(reader)
    expect(rec.provisioning.type).toBe('docker-compose')
    expect(rec.provisioning.composeBuild).toBeUndefined()
    expect(rec.notes.some((n) => n.field === 'composeBuild')).toBe(false)
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

  it('prefers docker-compose over kubernetes when the compose tab is selected', async () => {
    const reader = makeReader({
      'docker-compose.yml': 'services: {}',
      'k8s/deployment.yaml': deployment('registry/app:1.0.0'),
    })
    const rec = await detectKubernetesProvisioning(reader, { prefer: 'docker-compose' })
    expect(rec.detected).toBe(true)
    expect(rec.provisioning.type).toBe('docker-compose')
    expect(rec.provisioning.composePath).toBe('docker-compose.yml')
    // The co-existing k8s manifests are surfaced as a switch-back hint, not auto-picked.
    expect(rec.notes.some((n) => n.field === 'kubernetes' && n.confidence === 'low')).toBe(true)
  })

  it('falls back to kubernetes when the compose tab is selected but no compose file exists', async () => {
    const reader = makeReader({ 'k8s/deployment.yaml': deployment('registry/app:1.0.0') })
    const rec = await detectKubernetesProvisioning(reader, { prefer: 'docker-compose' })
    expect(rec.provisioning.type).toBe('kubernetes')
  })

  it('keeps the kubernetes-first order when the kubernetes tab is selected', async () => {
    const reader = makeReader({
      'docker-compose.yml': 'services: {}',
      'k8s/deployment.yaml': deployment('registry/app:1.0.0'),
    })
    const rec = await detectKubernetesProvisioning(reader, { prefer: 'kubernetes' })
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

  // --- Broadened layouts + monorepo awareness + candidate selection -----------------------------

  it('discovers an env-variant compose file when no canonical one exists', async () => {
    const reader = makeReader({ 'docker-compose.prod.yml': 'services:\n  api: {}\n' })
    const rec = await detectKubernetesProvisioning(reader)
    expect(rec.provisioning.type).toBe('docker-compose')
    expect(rec.provisioning.composePath).toBe('docker-compose.prod.yml')
  })

  it('prefers the canonical compose name over an override when both exist', async () => {
    const reader = makeReader({
      'compose.yaml': 'services:\n  api: {}\n',
      'compose.override.yaml': 'services:\n  api: {}\n',
    })
    const rec = await detectKubernetesProvisioning(reader)
    expect(rec.provisioning.composePath).toBe('compose.yaml')
  })

  it('discovers a compose file nested under deploy/', async () => {
    const reader = makeReader({ 'deploy/compose.yaml': 'services:\n  api: {}\n' })
    const rec = await detectKubernetesProvisioning(reader)
    expect(rec.provisioning.type).toBe('docker-compose')
    expect(rec.provisioning.composePath).toBe('deploy/compose.yaml')
  })

  it('surfaces compose service candidates when several services are declared', async () => {
    const reader = makeReader({ 'compose.yaml': 'services:\n  api: {}\n  worker: {}\n' })
    const rec = await detectKubernetesProvisioning(reader)
    expect(rec.composeServiceCandidates).toHaveLength(2)
    // No basename to match (root-level) ⇒ the first declared service is pre-selected.
    const recommended = rec.composeServiceCandidates!.filter((c) => c.recommended)
    expect(recommended).toHaveLength(1)
    expect(recommended[0]!.service).toBe('api')
    expect(rec.notes.some((n) => n.field === 'composeService')).toBe(true)
  })

  it('pre-selects the compose service matching the service directory basename', async () => {
    const reader = makeReader({
      'apps/worker/compose.yaml': 'services:\n  api: {}\n  worker: {}\n',
    })
    const rec = await detectKubernetesProvisioning(reader, { directory: 'apps/worker' })
    expect(rec.composeServiceCandidates!.find((c) => c.recommended)!.service).toBe('worker')
  })

  it('does NOT surface compose service candidates for a single-service compose file', async () => {
    const reader = makeReader({ 'compose.yaml': 'services:\n  api: {}\n' })
    const rec = await detectKubernetesProvisioning(reader)
    expect(rec.composeServiceCandidates).toBeUndefined()
  })

  it('detects manifests under newly-recognized roots (infrastructure/, gitops/)', async () => {
    for (const dir of ['infrastructure', 'gitops']) {
      const reader = makeReader({ [`${dir}/deployment.yaml`]: deployment('registry/app:1.0.0') })
      const rec = await detectKubernetesProvisioning(reader)
      expect(rec.provisioning.type).toBe('kubernetes')
      expect(rec.provisioning.manifestSource).toEqual({ type: 'colocated', path: dir })
    }
  })

  it('finds a monorepo service slice in a ROOT shared deploy dir (deploy/<svc>)', async () => {
    const reader = makeReader({
      'services/api/src/index.ts': 'export {}',
      'deploy/api/deployment.yaml': deployment('registry/api:1.0.0'),
      'deploy/web/deployment.yaml': deployment('registry/web:1.0.0'),
    })
    const rec = await detectKubernetesProvisioning(reader, { directory: 'services/api' })
    expect(rec.provisioning.type).toBe('kubernetes')
    expect(rec.provisioning.manifestSource).toEqual({ type: 'colocated', path: 'deploy/api' })
    // Both slices are surfaced; the basename-matched one is recommended.
    expect(rec.serviceDirCandidates).toHaveLength(2)
    const chosen = rec.serviceDirCandidates!.find((c) => c.recommended)!
    expect(chosen.name).toBe('api')
    expect(rec.notes.some((n) => n.field === 'serviceDir')).toBe(true)
  })

  it('surfaces every shared slice when the service matches slices under two shared roots', async () => {
    const reader = makeReader({
      'deploy/api/deployment.yaml': deployment('registry/api:1.0.0'),
      'k8s/api/deployment.yaml': deployment('registry/api:1.0.0'),
    })
    const rec = await detectKubernetesProvisioning(reader, { directory: 'services/api' })
    expect(rec.serviceDirCandidates!.map((c) => c.path).sort()).toEqual(['deploy/api', 'k8s/api'])
    // Exactly one recommended (SHARED_DEPLOY_ROOTS order ⇒ deploy/ wins).
    expect(rec.serviceDirCandidates!.filter((c) => c.recommended)).toHaveLength(1)
    expect(rec.provisioning.manifestSource).toEqual({ type: 'colocated', path: 'deploy/api' })
  })

  it('surfaces manifest-root candidates when several k8s roots resolve', async () => {
    const reader = makeReader({
      'k8s/deployment.yaml': deployment('registry/app:1.0.0'),
      'manifests/deployment.yaml': deployment('registry/app:1.0.0'),
    })
    const rec = await detectKubernetesProvisioning(reader)
    expect(rec.manifestRootCandidates!.map((c) => c.path).sort()).toEqual(['k8s', 'manifests'])
    expect(rec.manifestRootCandidates!.filter((c) => c.recommended)).toHaveLength(1)
    expect(rec.notes.some((n) => n.field === 'manifestRoot')).toBe(true)
  })

  it('does NOT surface manifest-root candidates for a single k8s root', async () => {
    const reader = makeReader({ 'k8s/deployment.yaml': deployment('registry/app:1.0.0') })
    const rec = await detectKubernetesProvisioning(reader)
    expect(rec.manifestRootCandidates).toBeUndefined()
  })

  it('does NOT run the shared-deploy scan when no service directory is given', async () => {
    const reader = makeReader({
      'k8s/deployment.yaml': deployment('registry/app:1.0.0'),
      'deploy/api/deployment.yaml': deployment('registry/api:1.0.0'),
    })
    const rec = await detectKubernetesProvisioning(reader)
    // Root-level detection uses the colocated k8s root; the deploy/api slice is NOT a candidate.
    expect(rec.serviceDirCandidates).toBeUndefined()
    expect(rec.provisioning.manifestSource).toEqual({ type: 'colocated', path: 'k8s' })
  })

  it('stays bounded and completes on a repo with many decoy directories', async () => {
    let reads = 0
    const decoyDirs = Array.from({ length: 60 }, (_, i) => `noise-${i}`)
    const base: ProvisioningRepoReader = {
      async getFile(path) {
        reads++
        return path === 'k8s/deployment.yaml' ? { content: deployment('registry/app:1.0.0') } : null
      },
      async listDirectory(path) {
        reads++
        if (path === '') {
          return [
            { name: 'k8s', type: 'dir', path: 'k8s' },
            ...decoyDirs.map((n) => ({ name: n, type: 'dir', path: n })),
          ]
        }
        if (path === 'k8s')
          return [{ name: 'deployment.yaml', type: 'file', path: 'k8s/deployment.yaml' }]
        // Every decoy dir looks non-empty to force listing, but holds nothing useful.
        return [{ name: 'readme.md', type: 'file', path: `${path}/readme.md` }]
      },
    }
    const rec = await detectKubernetesProvisioning(base)
    expect(rec.provisioning.type).toBe('kubernetes')
    // The read budget (200) caps the fan-out — the scan never runs away on the decoys.
    expect(reads).toBeLessThanOrEqual(210)
  })

  it('does NOT surface unrelated shared-deploy slices alongside colocated manifests', async () => {
    const reader = makeReader({
      'services/api/k8s/deployment.yaml': deployment('registry/api:1.0.0'),
      // A shared deploy dir exists but only holds OTHER services — not this one.
      'deploy/web/deployment.yaml': deployment('registry/web:1.0.0'),
    })
    const rec = await detectKubernetesProvisioning(reader, { directory: 'services/api' })
    expect(rec.provisioning.manifestSource).toEqual({ type: 'colocated', path: 'services/api/k8s' })
    // No `deploy/*` slice matches "api", so nothing noisy is surfaced.
    expect(rec.serviceDirCandidates).toBeUndefined()
    expect(rec.notes.some((n) => n.field === 'serviceDir')).toBe(false)
  })

  it('surfaces a same-name shared slice as a hint even when manifests are colocated', async () => {
    const reader = makeReader({
      'services/api/k8s/deployment.yaml': deployment('registry/api:1.0.0'),
      'deploy/api/deployment.yaml': deployment('registry/api:1.0.0'),
    })
    const rec = await detectKubernetesProvisioning(reader, { directory: 'services/api' })
    // Colocated manifests still win, but the matching shared slice is offered as an alternative.
    expect(rec.provisioning.manifestSource).toEqual({ type: 'colocated', path: 'services/api/k8s' })
    expect(rec.serviceDirCandidates!.map((c) => c.path)).toEqual(['deploy/api'])
    expect(rec.notes.some((n) => n.field === 'serviceDir')).toBe(true)
  })

  it('skips the shared-root container dir itself (manifests/services) as a slice', async () => {
    const reader = makeReader({
      'manifests/services/api/deployment.yaml': deployment('registry/api:1.0.0'),
    })
    const rec = await detectKubernetesProvisioning(reader, { directory: 'services/api' })
    // `manifests/services` is a container for slices, not a slice — only `manifests/services/api`.
    expect(rec.serviceDirCandidates!.map((c) => c.path)).toEqual(['manifests/services/api'])
    expect(rec.provisioning.manifestSource).toEqual({
      type: 'colocated',
      path: 'manifests/services/api',
    })
  })

  it('no longer treats apps/ as a shared-deploy root', async () => {
    const reader = makeReader({
      // Only an apps/<svc> slice exists (source-tree convention) and nothing is colocated.
      'apps/api/deployment.yaml': deployment('registry/api:1.0.0'),
    })
    const rec = await detectKubernetesProvisioning(reader, { directory: 'services/api' })
    expect(rec.detected).toBe(false)
    expect(rec.provisioning.type).toBe('infraless')
  })

  it('pre-selects a name-matched shared slice even when manifests cannot be confirmed inside it', async () => {
    const reader = makeReader({
      // The slice matches the service name but holds no recognizable k8s manifests.
      'deploy/api/notes.md': '# nothing useful here',
    })
    const rec = await detectKubernetesProvisioning(reader, { directory: 'services/api' })
    expect(rec.detected).toBe(true)
    expect(rec.provisioning.manifestSource).toEqual({ type: 'colocated', path: 'deploy/api' })
    expect(rec.serviceDirCandidates!.some((c) => c.recommended && c.name === 'api')).toBe(true)
  })

  it('does NOT fabricate a k8s pick from an arbitrary slice that matches no service name', async () => {
    const reader = makeReader({
      // A shared slice exists but for a DIFFERENT service, with no confirmable manifests.
      'deploy/web/notes.md': '# nothing useful here',
    })
    const rec = await detectKubernetesProvisioning(reader, { directory: 'services/api' })
    // No name match + no manifests ⇒ we don't invent a kubernetes recommendation.
    expect(rec.detected).toBe(false)
    expect(rec.provisioning.type).toBe('infraless')
  })
})

// --- Stack recipes: compose-repo detection extensions (slice 2) ---------------------------------
describe('detectKubernetesProvisioning — stack recipes', () => {
  it('does NOT attach a recipe to a plain single-file compose repo', async () => {
    const reader = makeReader({ 'compose.yaml': 'services:\n  api:\n    image: nginx\n' })
    const rec = await detectKubernetesProvisioning(reader)
    expect(rec.provisioning.type).toBe('docker-compose')
    // Nothing recipe-shaped ⇒ no recipe, no recipe candidate arrays, no recipe notes.
    expect(rec.provisioning.recipe).toBeUndefined()
    expect(rec.composeFileCandidates).toBeUndefined()
    expect(rec.profileCandidates).toBeUndefined()
    expect(rec.seedDumpCandidates).toBeUndefined()
    expect(rec.repoCliHint).toBeUndefined()
  })

  it('layers a bare dev.yml base with its OS-specific overrides (acme docker/dev.yml shape)', async () => {
    const reader = makeReader({
      'docker/dev.yml': 'services:\n  app:\n    image: registry/app\n',
      'docker/dev.wsl.override.yml': 'services:\n  app: {}\n',
      'docker/dev.mac.override.yml': 'services:\n  app: {}\n',
    })
    const rec = await detectKubernetesProvisioning(reader)
    expect(rec.provisioning.type).toBe('docker-compose')
    expect(rec.provisioning.composePath).toBe('docker/dev.yml')
    // Only the base is layered into the recipe; OS overrides are opt-in candidates.
    expect(rec.provisioning.recipe?.composeFiles).toEqual(['docker/dev.yml'])
    expect(rec.composeFileCandidates).toEqual([
      { path: 'docker/dev.yml', name: 'dev.yml', recommended: true },
      {
        path: 'docker/dev.mac.override.yml',
        name: 'dev.mac.override.yml',
        os: 'mac',
        recommended: false,
      },
      {
        path: 'docker/dev.wsl.override.yml',
        name: 'dev.wsl.override.yml',
        os: 'wsl',
        recommended: false,
      },
    ])
    expect(rec.notes.some((n) => n.field === 'composeFiles')).toBe(true)
  })

  it('layers a canonical compose file with its auto-merge override (both pre-selected)', async () => {
    const reader = makeReader({
      'compose.yaml': 'services:\n  api:\n    image: nginx\n',
      'compose.override.yaml': 'services:\n  api: {}\n',
    })
    const rec = await detectKubernetesProvisioning(reader)
    expect(rec.provisioning.composePath).toBe('compose.yaml')
    expect(rec.provisioning.recipe?.composeFiles).toEqual(['compose.yaml', 'compose.override.yaml'])
    // A non-OS override is a base layer ⇒ both recommended, neither carries an `os`.
    expect(rec.composeFileCandidates).toEqual([
      { path: 'compose.yaml', name: 'compose.yaml', recommended: true },
      { path: 'compose.override.yaml', name: 'compose.override.yaml', recommended: true },
    ])
  })

  it('recommends external networks the compose file expects to pre-exist', async () => {
    const reader = makeReader({
      'compose.yaml':
        'services:\n  app:\n    image: nginx\n    networks: [acme-net]\nnetworks:\n  acme-net:\n    external: true\n',
    })
    const rec = await detectKubernetesProvisioning(reader)
    expect(rec.provisioning.recipe?.externalNetworks).toEqual(['acme-net'])
    expect(rec.notes.some((n) => n.field === 'externalNetworks')).toBe(true)
    // A shared-stack binding is nudged (but no ref is fabricated — no stacks exist yet).
    expect(rec.notes.some((n) => n.field === 'sharedStackRefs')).toBe(true)
    expect(rec.provisioning.recipe?.sharedStackRefs).toBeUndefined()
  })

  it('resolves an external network name from external: { name }', async () => {
    const reader = makeReader({
      'compose.yaml':
        'services:\n  app:\n    image: nginx\nnetworks:\n  default:\n    external:\n      name: shared-bus\n',
    })
    const rec = await detectKubernetesProvisioning(reader)
    expect(rec.provisioning.recipe?.externalNetworks).toEqual(['shared-bus'])
  })

  it('surfaces compose profiles default-off as opt-in candidates (never in the recipe)', async () => {
    const reader = makeReader({
      'compose.yaml':
        'services:\n  app:\n    image: nginx\n    profiles: [full]\n  peer:\n    image: cockroach\n    profiles: [peer, backends]\n',
    })
    const rec = await detectKubernetesProvisioning(reader)
    // Deduped + sorted, all opt-in (recommended:false).
    expect(rec.profileCandidates).toEqual([
      { profile: 'backends', recommended: false },
      { profile: 'full', recommended: false },
      { profile: 'peer', recommended: false },
    ])
    expect(rec.provisioning.recipe?.composeProfiles).toBeUndefined()
    expect(rec.notes.some((n) => n.field === 'composeProfiles')).toBe(true)
  })

  it('pairs committed env/config templates with their materialization targets', async () => {
    const reader = makeReader({
      'compose.yaml': 'services:\n  app:\n    image: nginx\n',
      '.env.dev.local-dist': 'DATABASE_URL=\n',
      '.split.yaml.dist': 'flags: {}\n',
      '.env.example': 'API_KEY=\n',
      // A non-config template must NOT be treated as an env file.
      'README.dist': '# not an env file',
    })
    const rec = await detectKubernetesProvisioning(reader)
    expect(rec.provisioning.recipe?.envFiles).toEqual([
      { template: '.env.dev.local-dist', target: '.env.dev.local' },
      { template: '.env.example', target: '.env' },
      { template: '.split.yaml.dist', target: '.split.yaml' },
    ])
    expect(rec.notes.some((n) => n.field === 'envFiles')).toBe(true)
  })

  it('surfaces SQL seed dumps (nested one level) as low-confidence candidates, fullest pre-selected', async () => {
    const reader = makeReader({
      'compose.yaml': 'services:\n  app:\n    image: nginx\n',
      'deployment/acme-db-dummy/acme-dummy.sql': 'INSERT ...',
      'deployment/acme-db-dummy/acme-pre-dummy.sql': 'CREATE ...',
    })
    const rec = await detectKubernetesProvisioning(reader)
    expect(rec.seedDumpCandidates?.map((c) => c.path).sort()).toEqual([
      'deployment/acme-db-dummy/acme-dummy.sql',
      'deployment/acme-db-dummy/acme-pre-dummy.sql',
    ])
    // The full dummy dump outranks the "pre" (schema-ish) dump.
    const pick = rec.seedDumpCandidates?.find((c) => c.recommended)
    expect(pick?.path).toBe('deployment/acme-db-dummy/acme-dummy.sql')
    // Never auto-applied into the recipe — the wizard confirms.
    expect(rec.provisioning.recipe?.setupSteps).toBeUndefined()
    expect(rec.notes.some((n) => n.field === 'seedDump')).toBe(true)
  })

  it('flags a repo-CLI bring-up as a report-only hint (bin/*console* wins over a Makefile)', async () => {
    const reader = makeReader({
      'compose.yaml': 'services:\n  app:\n    image: nginx\n',
      'bin/dev-console': '#!/usr/bin/env bash',
      Makefile: 'setup:\n\tdocker compose up',
    })
    const rec = await detectKubernetesProvisioning(reader)
    expect(rec.repoCliHint).toEqual({ path: 'bin/dev-console', kind: 'repo-cli' })
    expect(rec.notes.some((n) => n.field === 'repoCli')).toBe(true)
  })

  it('flags a Makefile bring-up when there is no repo CLI', async () => {
    const reader = makeReader({
      'compose.yaml': 'services:\n  app:\n    image: nginx\n',
      Makefile: 'setup:\n\tdocker compose up',
    })
    const rec = await detectKubernetesProvisioning(reader)
    expect(rec.repoCliHint).toEqual({ path: 'Makefile', kind: 'makefile' })
  })

  // The pilot acceptance fixture: a acme-main-shaped complex compose repo (sanitized) exercising
  // every slice-2 extension at once — layered OS overrides, an external network, profiles, env-file
  // templates, a nested seed dump, and the repo's own imperative CLI.
  it('detects the full acme-main-shaped stack recipe end to end', async () => {
    const reader = makeReader({
      'docker/dev.yml':
        'services:\n' +
        '  app:\n' +
        '    image: registry/app\n' +
        '    profiles: [full]\n' +
        '    networks: [acme-net]\n' +
        '  cockroach:\n' +
        '    image: cockroachdb/cockroach\n' +
        '    profiles: [peer]\n' +
        'networks:\n' +
        '  acme-net:\n' +
        '    external: true\n',
      'docker/dev.wsl.override.yml': 'services:\n  app: {}\n',
      'docker/dev.mac.override.yml': 'services:\n  app: {}\n',
      '.env.dev.local-dist': 'DATABASE_URL=\n',
      '.split.yaml.dist': 'flags: {}\n',
      'deployment/acme-db-dummy/acme-dummy.sql': 'INSERT ...',
      'deployment/acme-db-dummy/acme-pre-dummy.sql': 'CREATE ...',
      'bin/dev-console': '#!/usr/bin/env bash',
    })
    const rec = await detectKubernetesProvisioning(reader)
    expect(rec.detected).toBe(true)
    expect(rec.provisioning.type).toBe('docker-compose')
    expect(rec.provisioning.composePath).toBe('docker/dev.yml')
    expect(rec.provisioning.recipe).toEqual({
      composeFiles: ['docker/dev.yml'],
      externalNetworks: ['acme-net'],
      envFiles: [
        { template: '.env.dev.local-dist', target: '.env.dev.local' },
        { template: '.split.yaml.dist', target: '.split.yaml' },
      ],
    })
    expect(
      rec.composeFileCandidates
        ?.filter((c) => c.os)
        .map((c) => c.os)
        .sort(),
    ).toEqual(['mac', 'wsl'])
    expect(rec.profileCandidates).toEqual([
      { profile: 'full', recommended: false },
      { profile: 'peer', recommended: false },
    ])
    expect(rec.seedDumpCandidates).toHaveLength(2)
    expect(rec.seedDumpCandidates?.find((c) => c.recommended)?.path).toBe(
      'deployment/acme-db-dummy/acme-dummy.sql',
    )
    expect(rec.repoCliHint).toEqual({ path: 'bin/dev-console', kind: 'repo-cli' })
  })

  it('does NOT detect a bare dev.yml that declares no services as docker-compose', async () => {
    // `dev.yml` is an ambiguous name (CLI / CI / Ansible config all use it); without a `services:`
    // map it must not be mistaken for a compose file.
    const reader = makeReader({ 'dev.yml': 'name: my-cli\ncommands:\n  build: make\n' })
    const rec = await detectKubernetesProvisioning(reader, { prefer: 'docker-compose' })
    expect(rec.detected).toBe(false)
    expect(rec.provisioning.type).toBe('infraless')
  })

  it('does NOT surface schema migrations under a migrations/ dir as seed dumps', async () => {
    const reader = makeReader({
      'compose.yaml': 'services:\n  app:\n    image: nginx\n',
      'db/migrations/0001_init.sql': 'CREATE TABLE ...',
      'db/migrations/0002_add_data.sql': 'INSERT ...',
      // A real seed dump beside the migrations IS surfaced.
      'db/seed-data.sql': 'INSERT ...',
    })
    const rec = await detectKubernetesProvisioning(reader)
    expect(rec.seedDumpCandidates?.map((c) => c.path)).toEqual(['db/seed-data.sql'])
  })

  it('does NOT materialize a non-env config sample (values.yaml.example) as an env file', async () => {
    const reader = makeReader({
      'compose.yaml': 'services:\n  app:\n    image: nginx\n',
      // A Helm values sample — a `.example` on a config file, NOT an env template.
      'values.yaml.example': 'replicas: 1\n',
      // A real env template IS materialized.
      '.env-dist': 'API_KEY=\n',
    })
    const rec = await detectKubernetesProvisioning(reader)
    expect(rec.provisioning.recipe?.envFiles).toEqual([{ template: '.env-dist', target: '.env' }])
  })

  it('picks the same env template regardless of directory-listing order (deterministic dedup)', async () => {
    const compose = 'services:\n  app:\n    image: nginx\n'
    // Both templates resolve to the same `.env` target — the dedup must not depend on listing order.
    const forward = await detectKubernetesProvisioning(
      makeReader({ 'compose.yaml': compose, '.env-dist': 'A=\n', '.env.example': 'A=\n' }),
    )
    const reverse = await detectKubernetesProvisioning(
      makeReader({ 'compose.yaml': compose, '.env.example': 'A=\n', '.env-dist': 'A=\n' }),
    )
    expect(forward.provisioning.recipe?.envFiles).toEqual([
      { template: '.env-dist', target: '.env' },
    ])
    expect(reverse.provisioning.recipe?.envFiles).toEqual(forward.provisioning.recipe?.envFiles)
  })
})

describe('detectCustomManifest', () => {
  it('keeps the current path when it already points to an existing file', async () => {
    const reader = makeReader({
      'services/api/preview.yaml': 'kind: X',
      'services/api/other.yaml': 'kind: Y',
    })
    const rec = await detectCustomManifest(reader, {
      directory: 'services/api',
      manifestId: 'kargo',
      defaultPath: 'preview.yaml',
      currentPath: 'services/api/other.yaml',
    })
    expect(rec.detected).toBe(true)
    expect(rec.provisioning).toMatchObject({
      type: 'custom',
      manifestId: 'kargo',
      manifestPath: 'services/api/other.yaml',
    })
    expect(rec.notes[0]!.confidence).toBe('high')
  })

  it('resolves the exact default path within a monorepo service subtree', async () => {
    const reader = makeReader({ 'services/api/deploy/preview.yaml': 'kind: X' })
    const rec = await detectCustomManifest(reader, {
      directory: 'services/api',
      manifestId: 'kargo',
      defaultPath: 'deploy/preview.yaml',
    })
    expect(rec.detected).toBe(true)
    expect(rec.provisioning.manifestPath).toBe('services/api/deploy/preview.yaml')
  })

  it('resolves the exact default path at the repo root for a non-monorepo service', async () => {
    const reader = makeReader({ 'deploy/preview.yaml': 'kind: X' })
    const rec = await detectCustomManifest(reader, {
      manifestId: 'kargo',
      defaultPath: 'deploy/preview.yaml',
    })
    expect(rec.detected).toBe(true)
    expect(rec.provisioning.manifestPath).toBe('deploy/preview.yaml')
  })

  it('finds a bare-filename default one level deep from the service root', async () => {
    const reader = makeReader({
      'services/api/README.md': '# api',
      'services/api/deploy/kargo.yaml': 'kind: X',
    })
    const rec = await detectCustomManifest(reader, {
      directory: 'services/api',
      manifestId: 'kargo',
      defaultPath: 'kargo.yaml',
    })
    expect(rec.detected).toBe(true)
    expect(rec.provisioning.manifestPath).toBe('services/api/deploy/kargo.yaml')
  })

  it('does not descend when the default carries a path (only the exact location is checked)', async () => {
    // The default has a directory component, so the one-level-deep search does NOT apply — a
    // file at a different depth must not be matched; we fall back to the default location.
    const reader = makeReader({ 'services/api/sub/config/kargo.yaml': 'kind: X' })
    const rec = await detectCustomManifest(reader, {
      directory: 'services/api',
      manifestId: 'kargo',
      defaultPath: 'config/kargo.yaml',
    })
    expect(rec.detected).toBe(false)
    expect(rec.provisioning.manifestPath).toBe('services/api/config/kargo.yaml')
    expect(rec.notes[0]!.confidence).toBe('low')
  })

  it('falls back to the default location (not found) so generate writes there', async () => {
    const reader = makeReader({ 'services/api/README.md': '# api' })
    const rec = await detectCustomManifest(reader, {
      directory: 'services/api',
      manifestId: 'kargo',
      defaultPath: 'deploy/preview.yaml',
    })
    expect(rec.detected).toBe(false)
    expect(rec.provisioning.manifestPath).toBe('services/api/deploy/preview.yaml')
  })

  it('keeps a deliberately-entered current path (not yet on disk) instead of the default location', async () => {
    // The user typed a path for a manifest they intend to generate; detect must not silently
    // overwrite it with the type default just because the file does not exist yet.
    const reader = makeReader({ 'services/api/README.md': '# api' })
    const rec = await detectCustomManifest(reader, {
      directory: 'services/api',
      manifestId: 'kargo',
      defaultPath: 'deploy/preview.yaml',
      currentPath: 'services/api/config/prod-kargo.yaml',
    })
    expect(rec.detected).toBe(false)
    expect(rec.provisioning.manifestPath).toBe('services/api/config/prod-kargo.yaml')
    expect(rec.notes[0]!.confidence).toBe('low')
  })

  it('has nothing to detect without a default or current path', async () => {
    const reader = makeReader({ 'services/api/README.md': '# api' })
    const rec = await detectCustomManifest(reader, {
      directory: 'services/api',
      manifestId: 'kargo',
    })
    expect(rec.detected).toBe(false)
    expect(rec.provisioning).toMatchObject({ type: 'custom', manifestId: 'kargo' })
    expect(rec.provisioning.manifestPath).toBeUndefined()
  })
})
