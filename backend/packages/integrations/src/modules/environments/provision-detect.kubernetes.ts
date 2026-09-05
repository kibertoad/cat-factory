import type {
  KubernetesHelmRelease,
  KubernetesImageOverride,
  KubernetesUrlSource,
  ProvisioningDetectionNote,
} from '@cat-factory/contracts'
import { BudgetedRepoScanner, joinRepoPath } from '@cat-factory/kernel'
import {
  asArray,
  asRecord,
  asString,
  isYamlFile,
  parseDocs,
  parseOne,
} from './provision-detect.yaml.js'

// The KUBERNETES half of provisioning auto-detection: what counts as a cluster manifest, the
// scan that folds a manifest tree into one {@link ManifestScan}, and the facts inferred back off
// that scan (URL source, image overrides, pinned Helm releases).
//
// Split out of `provision-detect.logic.ts` — which keeps the compose / env-template / seed-dump
// halves and the recommendation assembly, and imports this module — so neither file carries the
// other's heuristics. `KUSTOMIZATION_FILES` lives here because a kustomization IS a Kubernetes
// concept, and is re-imported by the detector's overlay resolution.

/** A `x.y.z` (optionally `v`-prefixed, with pre-release/build metadata) chart version. */
const PINNED_SEMVER = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
export const KUSTOMIZATION_FILES = ['kustomization.yaml', 'kustomization.yml', 'Kustomization']
/** Cap on the image overrides surfaced from one scan — a recommendation, not an inventory. */
const MAX_IMAGES = 8

// ---------------------------------------------------------------------------
// Kubernetes-manifest classification. A plain `kind` + `apiVersion` presence check is NOT enough:
// many non-cluster tools use the same envelope — the classic decoy is Backstage's `catalog-info.yaml`
// (`apiVersion: backstage.io/v1alpha1`, often `kind: Component`), which sits in EVERY service dir of a
// Backstage-catalogued monorepo. Treating those as manifests makes the detector classify a service's
// SOURCE directory (or the repo root) as a raw-manifest deploy target — a confident false positive.
// So a doc counts as a Kubernetes manifest only when its API group is Kubernetes-shaped (and not on the
// non-Kubernetes denylist). This is provider-neutral and repo-shape-agnostic — it keys off the manifest
// envelope, never a specific repo's layout.
// ---------------------------------------------------------------------------

/** The API group of an `apiVersion` (`apps/v1` → `apps`; a bare `v1` → `''`, the core group). */
function apiGroupOf(apiVersion: string): string {
  const slash = apiVersion.indexOf('/')
  return slash === -1 ? '' : apiVersion.slice(0, slash)
}

// API groups that share the `kind`+`apiVersion` envelope but are NOT Kubernetes cluster resources.
// Backstage is the common one in a service monorepo; the rest are other catalog/registry tools that
// occasionally sit in a repo. A doc in one of these groups is never a manifest, even when its `kind`
// collides with a real one (Backstage `Component` vs Kustomize `Component`).
const NON_KUBERNETES_API_GROUPS = new Set(['backstage.io', 'catalog.cattle.io'])
// Built-in Kubernetes kinds + the kinds of the most common GitOps/operator CRDs. A doc with one of
// these kinds is a manifest UNLESS its group is denylisted above (so a Backstage `Component` is still
// rejected). This positively catches manifests whose CRD group we don't enumerate below.
const KUBERNETES_KINDS = new Set([
  // Workloads
  'Deployment',
  'StatefulSet',
  'DaemonSet',
  'ReplicaSet',
  'ReplicationController',
  'Pod',
  'Job',
  'CronJob',
  // Networking / config / storage
  'Service',
  'Ingress',
  'IngressClass',
  'Endpoints',
  'EndpointSlice',
  'ConfigMap',
  'Secret',
  'Namespace',
  'PersistentVolume',
  'PersistentVolumeClaim',
  'ServiceAccount',
  'Role',
  'RoleBinding',
  'ClusterRole',
  'ClusterRoleBinding',
  'HorizontalPodAutoscaler',
  'PodDisruptionBudget',
  'NetworkPolicy',
  'ResourceQuota',
  'LimitRange',
  'PriorityClass',
  // Gateway API
  'Gateway',
  'HTTPRoute',
  'GRPCRoute',
  'TCPRoute',
  'ReferenceGrant',
  // Kustomize
  'Kustomization',
  'Component',
  // GitOps / operators (common CRDs)
  'Application',
  'ApplicationSet',
  'HelmRelease',
  'HelmRepository',
  'Certificate',
  'Issuer',
  'ClusterIssuer',
  'ServiceMonitor',
  'PrometheusRule',
  'SealedSecret',
  'ExternalSecret',
])
// API-group suffixes that mark a CRD as a Kubernetes cluster resource even when its `kind` isn't in
// the set above. Kept to well-known operator ecosystems so a random `apiVersion: mytool/v1` config
// file isn't mistaken for a manifest. `*.k8s.io` / `*.x-k8s.io` are handled separately (any such
// group is Kubernetes by definition).
const KUBERNETES_CRD_GROUP_SUFFIXES = [
  'argoproj.io',
  'fluxcd.io',
  'cert-manager.io',
  'coreos.com',
  'istio.io',
  'linkerd.io',
  'crossplane.io',
  'bitnami.com',
  'external-secrets.io',
  'jetstack.io',
  'gatekeeper.sh',
  'kyverno.io',
]

/**
 * True when a parsed YAML doc is a Kubernetes cluster manifest (vs a decoy that merely shares the
 * `kind`+`apiVersion` envelope — a Backstage `catalog-info.yaml`, a CI/tool config, generic app
 * config). The rule, in order: no kind/apiVersion ⇒ no; denylisted group ⇒ no; known Kubernetes kind
 * ⇒ yes; core group (`v1`, `apps/v1`) or a `*.k8s.io` / kustomize / known-operator group ⇒ yes;
 * otherwise (an unknown custom group) ⇒ no. Conservative on the unknown tail on purpose: the cost of
 * a false positive here is a source dir wrongly offered as a deploy target, whereas a genuinely exotic
 * CRD-only layout is covered by the `serviceManifestPaths` escape hatch.
 */
function isKubernetesManifestDoc(doc: Record<string, unknown>): boolean {
  const kind = asString(doc.kind)
  const apiVersion = asString(doc.apiVersion)
  if (!kind || !apiVersion) return false
  const group = apiGroupOf(apiVersion)
  if (NON_KUBERNETES_API_GROUPS.has(group)) return false
  if (KUBERNETES_KINDS.has(kind)) return true
  if (group === '' || group.endsWith('.k8s.io') || group.endsWith('.x-k8s.io')) return true
  return KUBERNETES_CRD_GROUP_SUFFIXES.some((s) => group === s || group.endsWith(`.${s}`))
}

/** Parse a file's YAML docs and keep only the ones that are real Kubernetes manifests. */
export function parseManifestDocs(content: string): Record<string, unknown>[] {
  return parseDocs(content).filter(isKubernetesManifestDoc)
}

/** Accumulated facts read out of the manifest tree. */
export interface ManifestScan {
  kinds: Set<string>
  ingressHosts: string[]
  ingressNames: string[]
  loadBalancerServices: { name: string; port?: number }[]
  gatewayNames: string[]
  httpRouteNames: string[]
  namespaces: string[]
  kustomizeImages: string[]
  deploymentImages: string[]
  secretGenerator: { envFile: string; baseDir: string } | null
}

export function emptyScan(): ManifestScan {
  return {
    kinds: new Set(),
    ingressHosts: [],
    ingressNames: [],
    loadBalancerServices: [],
    gatewayNames: [],
    httpRouteNames: [],
    namespaces: [],
    kustomizeImages: [],
    deploymentImages: [],
    secretGenerator: null,
  }
}

/** Pull the URL-bearing kinds + image refs + pinned namespace out of one manifest document. */
function scanManifestDoc(doc: Record<string, unknown>, scan: ManifestScan): void {
  const kind = asString(doc.kind)
  if (!kind) return
  scan.kinds.add(kind)
  const metadata = asRecord(doc.metadata) ?? {}
  const name = asString(metadata.name)
  const ns = asString(metadata.namespace)
  if (ns) scan.namespaces.push(ns)
  const spec = asRecord(doc.spec) ?? {}

  if (kind === 'Ingress') {
    if (name) scan.ingressNames.push(name)
    for (const rule of asArray(spec.rules)) {
      const host = asString(asRecord(rule)?.host)
      // Skip wildcard hosts — they aren't a usable concrete URL.
      if (host && !host.includes('*')) scan.ingressHosts.push(host)
    }
  } else if (kind === 'Service' && asString(spec.type) === 'LoadBalancer' && name) {
    const firstPort = asRecord(asArray(spec.ports)[0])
    const port = typeof firstPort?.port === 'number' ? firstPort.port : undefined
    scan.loadBalancerServices.push(port !== undefined ? { name, port } : { name })
  } else if (kind === 'Gateway') {
    if (name) scan.gatewayNames.push(name)
  } else if (kind === 'HTTPRoute') {
    if (name) scan.httpRouteNames.push(name)
  } else if (kind === 'Deployment' || kind === 'StatefulSet' || kind === 'DaemonSet') {
    const containers = asArray(asRecord(asRecord(spec.template)?.spec)?.containers)
    for (const c of containers) {
      const image = asString(asRecord(c)?.image)
      if (image) scan.deploymentImages.push(image)
    }
  }
}

/** Read every YAML doc in a flat directory (non-recursive) into the scan. */
export async function scanRawDir(
  scanner: BudgetedRepoScanner,
  dir: string,
  scan: ManifestScan,
): Promise<void> {
  const entries = await scanner.listDir(dir)
  for (const entry of entries) {
    if (entry.type !== 'dir' && isYamlFile(entry.name)) {
      const content = await scanner.getFile(joinRepoPath(dir, entry.name))
      if (content) for (const doc of parseManifestDocs(content)) scanManifestDoc(doc, scan)
    }
  }
}

/**
 * Walk a kustomization tree from `dir`: collect its `images`/`secretGenerator`/`namespace`,
 * then follow `resources`/`bases`/`components` one ref at a time (a directory recurses, a file
 * is parsed for kinds). Bounded by `depth` + the scanner's global read budget.
 */
export async function walkKustomize(
  scanner: BudgetedRepoScanner,
  dir: string,
  scan: ManifestScan,
  depth: number,
): Promise<void> {
  if (depth > 4) return
  const kustomization = await scanner.getFirstFile(dir, KUSTOMIZATION_FILES)
  if (!kustomization) {
    // No kustomization here — treat the directory as a flat set of raw manifests.
    await scanRawDir(scanner, dir, scan)
    return
  }
  const parsed = parseOne(kustomization.content)
  if (!parsed) return

  const ns = asString(parsed.namespace)
  if (ns) scan.namespaces.push(ns)

  for (const image of asArray(parsed.images)) {
    const imageName = asString(asRecord(image)?.name)
    if (imageName) scan.kustomizeImages.push(imageName)
  }

  if (!scan.secretGenerator) {
    for (const gen of asArray(parsed.secretGenerator)) {
      const envs = asArray(asRecord(gen)?.envs)
      const envFile = asString(envs[0])
      if (envFile) {
        scan.secretGenerator = { envFile, baseDir: dir }
        break
      }
    }
  }

  const refs = [
    ...asArray(parsed.resources),
    ...asArray(parsed.bases),
    ...asArray(parsed.components),
  ]
    .map(asString)
    .filter((r): r is string => r !== undefined)

  for (const ref of refs) {
    // Skip remote bases (URLs / git refs) — only local paths are checkout-free readable.
    if (ref.includes('://') || ref.startsWith('git@')) continue
    const refPath = joinRepoPath(dir, ref)
    if (isYamlFile(ref)) {
      const content = await scanner.getFile(refPath)
      if (content) for (const doc of parseManifestDocs(content)) scanManifestDoc(doc, scan)
    } else {
      await walkKustomize(scanner, refPath, scan, depth + 1)
    }
  }
}

/** Infer the URL source from the manifest kinds (HTTPRoute → Gateway → Ingress → LB Service). */
export function inferUrlSource(scan: ManifestScan): KubernetesUrlSource | undefined {
  if (scan.httpRouteNames.length > 0) {
    const only = scan.httpRouteNames.length === 1 ? scan.httpRouteNames[0] : undefined
    return { source: 'httpRouteStatus', ...(only ? { httpRouteName: only } : {}) }
  }
  if (scan.gatewayNames.length > 0) {
    const only = scan.gatewayNames.length === 1 ? scan.gatewayNames[0] : undefined
    return { source: 'gatewayStatus', ...(only ? { gatewayName: only } : {}) }
  }
  if (scan.ingressHosts.length > 0) {
    return { source: 'ingressTemplate', hostTemplate: scan.ingressHosts[0]! }
  }
  if (scan.kinds.has('Ingress')) {
    const only = scan.ingressNames.length === 1 ? scan.ingressNames[0] : undefined
    return { source: 'ingressStatus', ...(only ? { ingressName: only } : {}) }
  }
  const lb = scan.loadBalancerServices[0]
  if (lb) {
    return { source: 'serviceStatus', serviceName: lb.name, ...(lb.port ? { port: lb.port } : {}) }
  }
  return undefined
}

/** Bare image name (repo) with any `:tag` / `@digest` suffix stripped, for an override match. */
function bareImageName(image: string): string {
  const atDigest = image.split('@')[0]!
  const lastSlash = atDigest.lastIndexOf('/')
  const lastColon = atDigest.lastIndexOf(':')
  return lastColon > lastSlash ? atDigest.slice(0, lastColon) : atDigest
}

export function inferImageOverrides(scan: ManifestScan): KubernetesImageOverride[] {
  const names =
    scan.kustomizeImages.length > 0
      ? [...new Set(scan.kustomizeImages)]
      : [...new Set(scan.deploymentImages.map(bareImageName))]
  return names.slice(0, MAX_IMAGES).map((name) => ({ name, newTagTemplate: '{{branch}}' }))
}

function pinnedHelmReleases(parsedReleases: unknown[]): {
  releases: KubernetesHelmRelease[]
  unpinned: number
} {
  const releases: KubernetesHelmRelease[] = []
  let unpinned = 0
  for (const raw of parsedReleases) {
    const r = asRecord(raw)
    if (!r) continue
    const name = asString(r.name)
    const chart = asString(r.chart)
    const version = asString(r.version)
    if (!name || !chart) continue
    if (!version || !PINNED_SEMVER.test(version)) {
      unpinned++
      continue
    }
    const repo = asString(r.repo) ?? asString(r.repoUrl)
    releases.push({ name, chart, version, ...(repo ? { repo } : {}) })
  }
  return { releases, unpinned }
}

export async function inferHelmReleases(
  scanner: BudgetedRepoScanner,
  root: string,
  k8sDir: string,
): Promise<{ releases: KubernetesHelmRelease[]; note: ProvisioningDetectionNote | null }> {
  for (const dir of new Set([root, k8sDir])) {
    const helmfile = await scanner.getFirstFile(dir, ['helmfile.yaml', 'helmfile.yml'])
    if (helmfile) {
      const parsed = parseOne(helmfile.content)
      const { releases, unpinned } = pinnedHelmReleases(asArray(parsed?.releases))
      if (releases.length > 0 || unpinned > 0) {
        return {
          releases,
          note: {
            field: 'helmReleases',
            confidence: 'low',
            message:
              releases.length > 0
                ? `Proposed ${releases.length} helm release(s) from ${joinRepoPath(dir, helmfile.name)}; review charts/versions before applying.${unpinned > 0 ? ` ${unpinned} release(s) had an unpinned version and were skipped.` : ''}`
                : `Found ${joinRepoPath(dir, helmfile.name)} but its release versions aren't pinned — pin them to a semver to enable.`,
          },
        }
      }
    }
    const chart = await scanner.getFirstFile(dir, ['Chart.yaml', 'Chart.yml'])
    if (chart) {
      const parsed = parseOne(chart.content)
      const deps = asArray(parsed?.dependencies).map((d) => {
        const r = asRecord(d) ?? {}
        return { name: r.name, chart: r.name, version: r.version, repo: r.repository }
      })
      const { releases, unpinned } = pinnedHelmReleases(deps)
      if (releases.length > 0 || unpinned > 0) {
        return {
          releases,
          note: {
            field: 'helmReleases',
            confidence: 'low',
            message:
              releases.length > 0
                ? `Proposed ${releases.length} helm release(s) from ${joinRepoPath(dir, chart.name)} dependencies; review before applying.`
                : `Found ${joinRepoPath(dir, chart.name)} dependencies but their versions aren't pinned to a semver.`,
          },
        }
      }
    }
  }
  return { releases: [], note: null }
}
