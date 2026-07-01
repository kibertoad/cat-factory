import type {
  KubernetesHelmRelease,
  KubernetesImageOverride,
  KubernetesManifestSource,
  KubernetesRenderer,
  KubernetesSecretInjection,
  KubernetesUrlSource,
  ProvisionType,
  ProvisioningComposeServiceCandidate,
  ProvisioningDetectionNote,
  ProvisioningManifestRootCandidate,
  ProvisioningOverlayCandidate,
  ProvisioningRecommendation,
  ProvisioningServiceDirCandidate,
  ServiceProvisioning,
} from '@cat-factory/contracts'
import { parse as parseYaml, parseAllDocuments } from 'yaml'

// ---------------------------------------------------------------------------
// Per-service provisioning AUTO-DETECTION (slice 11): a deterministic, pure-TS heuristic
// that proposes a NON-BINDING recommended `kubernetes` (or `docker-compose`) provisioning
// config from a service's repo, read CHECKOUT-FREE over a minimal RepoFiles-shaped reader.
// No LLM, no clone — just targeted directory listings + YAML parsing. The user always
// confirms/edits; nothing here is applied silently. Mirrors the spirit of the compose
// autodiscovery: high-confidence facts are inferred deterministically; ambiguous ones
// (which overlay is the ephemeral one, which helm releases) are surfaced as candidates with
// a hint rather than guessed. See docs/initiatives/per-service-provision-types.md (slice 11).
// ---------------------------------------------------------------------------

/**
 * The narrow slice of {@link RepoFiles} the detector needs — a {@link RepoFiles} satisfies it
 * structurally, and a test supplies an in-memory fake. Reads are best-effort: a missing path
 * yields `null` / `[]` (never throws), so the heuristics degrade gracefully on partial repos.
 */
export interface ProvisioningRepoReader {
  getFile(path: string, gitRef?: string): Promise<{ content: string } | null>
  listDirectory(
    path: string,
    gitRef?: string,
  ): Promise<{ name: string; type: string; path: string }[]>
}

export interface DetectProvisioningOptions {
  /** Service subdirectory within the repo (monorepo); absent/'' ⇒ the repo root. */
  directory?: string
  /** Git ref to read at; absent ⇒ the reader's default branch. */
  gitRef?: string
  /**
   * The provision type the user currently has SELECTED. The detector prioritizes finding THIS
   * option before the other: `docker-compose` ⇒ recommend a compose file when one exists (even
   * if Kubernetes manifests are also present); anything else (incl. absent) ⇒ prefer Kubernetes
   * (the richer config), the historical default. Only `kubernetes`/`docker-compose` change the
   * search order — the other types have nothing to auto-detect.
   */
  prefer?: ProvisionType
}

const PINNED_SEMVER = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const KUSTOMIZATION_FILES = ['kustomization.yaml', 'kustomization.yml', 'Kustomization']
// Compose file names, canonical-first: the officially-preferred `compose.yaml`, then the legacy
// `docker-compose.*`, then the auto-merged `*.override.*`, then the common env-variant names. The
// first present name wins as the recommended `composePath`, so the base names must precede the
// overrides/variants.
const COMPOSE_FILES = [
  'compose.yaml',
  'compose.yml',
  'docker-compose.yaml',
  'docker-compose.yml',
  'compose.override.yaml',
  'compose.override.yml',
  'docker-compose.override.yaml',
  'docker-compose.override.yml',
  'docker-compose.prod.yaml',
  'docker-compose.prod.yml',
  'docker-compose.dev.yaml',
  'docker-compose.dev.yml',
]
// Directories (relative to the service root) a compose file commonly nests under, in addition to
// the root itself. One `listDir` per entry (cheap membership test against COMPOSE_FILES).
const COMPOSE_DIR_CANDIDATES = ['', 'deploy', 'docker', '.docker', 'compose']
// Directories (relative to the service root) commonly holding the deploy manifests. Common names
// FIRST so the read budget is spent on the likely layouts before the rare ones.
const K8S_DIR_CANDIDATES = [
  '',
  'k8s',
  'kubernetes',
  'deploy',
  'deployment',
  'manifests',
  'charts',
  'chart',
  'helm',
  'kustomize',
  '.k8s',
  '.kube',
  'ops',
  'ops/k8s',
  'infra',
  'infrastructure',
  'infra/k8s',
  'infra/kubernetes',
  'infra/manifests',
  'deploy/k8s',
  'deploy/kubernetes',
  'config/k8s',
  'gitops',
  '.deploy',
]
// Wrapper dirs (e.g. `deploy/`, `deployment/`) frequently nest the actual manifests under a
// `k8s`/`kubernetes` child (`deployment/k8s/{base,overlays}`); when a candidate has no direct
// markers we descend one level into such a child so that layout still resolves.
const K8S_NESTED_SUBDIRS = [
  'k8s',
  'kubernetes',
  'manifests',
  'overlays',
  'base',
  'helm',
  'charts',
  'kustomize',
]
// Root shared-deploy dirs a monorepo keys per-service subfolders under (e.g. `deploy/<svc>`,
// `k8s/<svc>`, `manifests/services/<svc>`). Scanned at the REPO ROOT only when a service
// subdirectory was given, to locate the slice belonging to this service. Deliberately excludes
// `apps/` — that is almost always the SOURCE tree, not deploy manifests, so listing every app as a
// "deploy folder" candidate is noise (a service whose manifests really live under `apps/<svc>` is
// already covered by the colocated scan of its own directory).
const SHARED_DEPLOY_ROOTS = [
  'deploy',
  'k8s',
  'kubernetes',
  'manifests',
  'manifests/services',
  'infra/manifests',
]
// Fast membership test used to drop a shared-root child that is ITSELF another shared root (e.g.
// `manifests/services`, surfaced as a child of `manifests`) so it isn't offered as a bogus slice.
const SHARED_DEPLOY_ROOT_SET = new Set(SHARED_DEPLOY_ROOTS)
// The most k8s roots we collect as candidates (bounds the candidate list + the reads it triggers).
const MAX_MANIFEST_ROOTS = 6
// Overlay names ranked most→least likely to be the ephemeral/preview environment.
const OVERLAY_RANK = [
  'prenv',
  'preview',
  'pr',
  'ephemeral',
  'eph',
  'dev',
  'development',
  'staging',
  'stage',
  'test',
  'testing',
  'qa',
]
const ENV_EXAMPLE_FILES = ['.env.example', '.env.sample', '.env.template', '.env.dist']
// Bounds the total reads so a pathological repo can't fan out unboundedly. Raised from 80 because
// the candidate lists grew (more k8s dirs, compose dirs, shared-deploy roots) and manifest-root
// collection no longer short-circuits on the first hit — still tiny versus a real API. Reads are
// intentionally SEQUENTIAL (not batched/parallel): the budget short-circuit and the "first present
// name/dir wins" ordering both depend on deterministic, in-order accounting. In practice a real
// repo resolves in a handful of reads well before the cap; the cap only bites on decoy-heavy repos,
// where truncation is surfaced as a note (see `Scanner.exhausted`).
const READ_BUDGET = 200
const MAX_IMAGES = 8

/** Join + normalize repo-relative path segments, collapsing `.`/`..` (resolves `../base` refs). */
function joinPath(...parts: (string | undefined)[]): string {
  const segs: string[] = []
  for (const part of parts) {
    if (!part) continue
    for (const seg of part.split('/')) {
      if (!seg || seg === '.') continue
      if (seg === '..') segs.pop()
      else segs.push(seg)
    }
  }
  return segs.join('/')
}

function isYamlFile(name: string): boolean {
  return name.endsWith('.yaml') || name.endsWith('.yml')
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function parseDocs(content: string): Record<string, unknown>[] {
  try {
    return parseAllDocuments(content)
      .map((d) => d.toJS() as unknown)
      .map(asRecord)
      .filter((r): r is Record<string, unknown> => r !== null)
  } catch {
    return []
  }
}

function parseOne(content: string): Record<string, unknown> | null {
  try {
    return asRecord(parseYaml(content) as unknown)
  } catch {
    return null
  }
}

/** Stateful repo reader with a hard read budget so detection can't fan out without bound. */
class Scanner {
  private reads = 0
  constructor(
    private readonly reader: ProvisioningRepoReader,
    private readonly gitRef: string | undefined,
  ) {}

  /** True once the read budget was hit — the scan may have stopped short of the full repo. */
  get exhausted(): boolean {
    return this.reads >= READ_BUDGET
  }

  async getFile(path: string): Promise<string | null> {
    if (this.reads >= READ_BUDGET) return null
    this.reads++
    const file = await this.reader.getFile(path, this.gitRef)
    return file?.content ?? null
  }

  /** Read the first present file among `names` in `dir`; returns its content + matched name. */
  async getFirstFile(
    dir: string,
    names: string[],
  ): Promise<{ name: string; content: string } | null> {
    for (const name of names) {
      const content = await this.getFile(joinPath(dir, name))
      if (content !== null) return { name, content }
    }
    return null
  }

  async listDir(path: string): Promise<{ name: string; type: string; path: string }[]> {
    if (this.reads >= READ_BUDGET) return []
    this.reads++
    try {
      return await this.reader.listDirectory(path, this.gitRef)
    } catch {
      return []
    }
  }
}

/** Accumulated facts read out of the manifest tree. */
interface ManifestScan {
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

function emptyScan(): ManifestScan {
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
async function scanRawDir(scanner: Scanner, dir: string, scan: ManifestScan): Promise<void> {
  const entries = await scanner.listDir(dir)
  for (const entry of entries) {
    if (entry.type !== 'dir' && isYamlFile(entry.name)) {
      const content = await scanner.getFile(joinPath(dir, entry.name))
      if (content) for (const doc of parseDocs(content)) scanManifestDoc(doc, scan)
    }
  }
}

/**
 * Walk a kustomization tree from `dir`: collect its `images`/`secretGenerator`/`namespace`,
 * then follow `resources`/`bases`/`components` one ref at a time (a directory recurses, a file
 * is parsed for kinds). Bounded by `depth` + the scanner's global read budget.
 */
async function walkKustomize(
  scanner: Scanner,
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
    const refPath = joinPath(dir, ref)
    if (isYamlFile(ref)) {
      const content = await scanner.getFile(refPath)
      if (content) for (const doc of parseDocs(content)) scanManifestDoc(doc, scan)
    } else {
      await walkKustomize(scanner, refPath, scan, depth + 1)
    }
  }
}

/** Parse `KEY=...` lines of a dotenv example into its key names (values are the user's). */
function parseEnvExampleKeys(content: string): string[] {
  const keys: string[] = []
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const withoutExport = line.startsWith('export ') ? line.slice('export '.length) : line
    const eq = withoutExport.indexOf('=')
    if (eq <= 0) continue
    const key = withoutExport.slice(0, eq).trim()
    if (/^[A-Za-z0-9_.-]+$/.test(key)) keys.push(key)
  }
  return [...new Set(keys)]
}

/** A k8s manifest root: the directory + whether it carries an `overlays/` tree. */
interface KubernetesRoot {
  dir: string
  hasOverlays: boolean
  hasKustomization: boolean
}

/**
 * Decide whether `dir` (with its already-listed `entries`) is a k8s manifest root: it is when it
 * carries a kustomization / an `overlays/` or `base(s)/` subtree, or — lacking those markers — at
 * least one YAML file that parses as a real manifest (`kind` + `apiVersion`).
 */
async function evaluateK8sDir(
  scanner: Scanner,
  dir: string,
  entries: { name: string; type: string; path: string }[],
): Promise<KubernetesRoot | null> {
  const hasKustomization = entries.some(
    (e) => e.type !== 'dir' && KUSTOMIZATION_FILES.includes(e.name),
  )
  const hasOverlays = entries.some((e) => e.type === 'dir' && e.name === 'overlays')
  const hasBase = entries.some((e) => e.type === 'dir' && (e.name === 'base' || e.name === 'bases'))
  if (hasKustomization || hasOverlays || hasBase) {
    return { dir, hasOverlays, hasKustomization }
  }
  // No kustomize markers — accept the dir only if it holds an actual k8s manifest.
  for (const entry of entries) {
    if (entry.type === 'dir' || !isYamlFile(entry.name)) continue
    const content = await scanner.getFile(joinPath(dir, entry.name))
    const looksLikeManifest =
      content !== null && parseDocs(content).some((d) => asString(d.kind) && asString(d.apiVersion))
    if (looksLikeManifest) return { dir, hasOverlays: false, hasKustomization: false }
  }
  return null
}

/**
 * Collect EVERY k8s manifest root under `root` (in `K8S_DIR_CANDIDATES` order — common names first),
 * descending one level into wrapper dirs. Bounded by `MAX_MANIFEST_ROOTS` + the read budget. The
 * first entry is the highest-ranked (the one the detector prefills); the rest drive the "which root"
 * picker. Dedupes by directory so a dir reachable both directly and as a nested child isn't listed twice.
 */
async function collectKubernetesRoots(scanner: Scanner, root: string): Promise<KubernetesRoot[]> {
  const found: KubernetesRoot[] = []
  const seen = new Set<string>()
  const add = (r: KubernetesRoot): void => {
    if (seen.has(r.dir)) return
    seen.add(r.dir)
    found.push(r)
  }
  for (const candidate of K8S_DIR_CANDIDATES) {
    if (found.length >= MAX_MANIFEST_ROOTS) break
    const dir = joinPath(root, candidate)
    const entries = await scanner.listDir(dir)
    if (entries.length === 0) continue
    const direct = await evaluateK8sDir(scanner, dir, entries)
    if (direct) {
      add(direct)
      continue
    }
    // A wrapper dir (e.g. `deployment/`) may nest the manifests under a `k8s`/`kubernetes` child
    // (`deployment/k8s/{base,overlays}`). Descend one level into any such child that exists.
    for (const entry of entries) {
      if (found.length >= MAX_MANIFEST_ROOTS) break
      if (entry.type !== 'dir' || !K8S_NESTED_SUBDIRS.includes(entry.name)) continue
      const nestedDir = joinPath(dir, entry.name)
      const nested = await evaluateK8sDir(scanner, nestedDir, await scanner.listDir(nestedDir))
      if (nested) add(nested)
    }
  }
  return found
}

/**
 * When a service SUBDIR was given but its manifests aren't colocated, scan the repo's root
 * shared-deploy dirs for a per-service slice keyed by the service basename. Returns every candidate
 * slice (an immediate child dir of a `SHARED_DEPLOY_ROOTS` entry), with the basename-matching one(s)
 * flagged `recommended`. Case-insensitive fallback when no exact match exists.
 */
async function findServiceDeployCandidates(
  scanner: Scanner,
  serviceBasename: string,
): Promise<ProvisioningServiceDirCandidate[]> {
  const candidates: { path: string; name: string }[] = []
  const seen = new Set<string>()
  for (const deployRoot of SHARED_DEPLOY_ROOTS) {
    for (const entry of await scanner.listDir(deployRoot)) {
      if (entry.type !== 'dir') continue
      const path = joinPath(deployRoot, entry.name)
      if (seen.has(path)) continue
      // Skip a child that is itself a shared-deploy root (e.g. `manifests/services`): it's a
      // container for slices, not a per-service slice of its own.
      if (SHARED_DEPLOY_ROOT_SET.has(path)) continue
      seen.add(path)
      candidates.push({ path, name: entry.name })
    }
  }
  if (candidates.length === 0) return []
  // Flag exactly ONE slice recommended: the first exact-basename match (SHARED_DEPLOY_ROOTS order),
  // else the first case-insensitive match, else none (the user picks from the surfaced list).
  const lower = serviceBasename.toLowerCase()
  const exactIdx = candidates.findIndex((c) => c.name === serviceBasename)
  const chosenIdx =
    exactIdx !== -1 ? exactIdx : candidates.findIndex((c) => c.name.toLowerCase() === lower)
  return candidates.map((c, i) => ({ ...c, recommended: i === chosenIdx }))
}

interface ComposeHit {
  /** Repo-relative compose file path (the value `composePath` would take). */
  path: string
  /** The declared `services:` keys (empty when unparseable / none). */
  services: string[]
}

/**
 * Locate a Docker Compose file for the service, checking the service root AND the dirs it commonly
 * nests under (`deploy/`, `docker/`, …). One `listDir` per candidate dir; the canonical file name
 * wins (COMPOSE_FILES is canonical-first). Also parses the `services:` keys so callers can surface
 * a service picker when several are declared.
 */
async function findCompose(scanner: Scanner, root: string): Promise<ComposeHit | null> {
  for (const dir of COMPOSE_DIR_CANDIDATES) {
    const dirPath = joinPath(root, dir)
    const entries = await scanner.listDir(dirPath)
    if (entries.length === 0) continue
    const names = new Set(entries.filter((e) => e.type !== 'dir').map((e) => e.name))
    for (const candidate of COMPOSE_FILES) {
      if (!names.has(candidate)) continue
      const path = joinPath(dirPath, candidate)
      const content = await scanner.getFile(path)
      const services = content ? Object.keys(asRecord(parseOne(content)?.services) ?? {}) : []
      return { path, services }
    }
  }
  return null
}

function rankOverlay(name: string): number {
  const idx = OVERLAY_RANK.indexOf(name.toLowerCase())
  return idx === -1 ? OVERLAY_RANK.length : idx
}

/** Resolve the manifest source path + renderer + (when several) the overlay candidates. */
async function resolveManifestSource(
  scanner: Scanner,
  k8s: KubernetesRoot,
): Promise<{
  path: string
  renderer: KubernetesRenderer
  overlayCandidates?: ProvisioningOverlayCandidate[]
}> {
  if (k8s.hasOverlays) {
    const overlaysDir = joinPath(k8s.dir, 'overlays')
    const overlays = (await scanner.listDir(overlaysDir)).filter((e) => e.type === 'dir')
    if (overlays.length > 0) {
      const ranked = [...overlays].sort((a, b) => rankOverlay(a.name) - rankOverlay(b.name))
      const chosen = ranked[0]!
      const candidates: ProvisioningOverlayCandidate[] = ranked.map((o) => ({
        path: joinPath(overlaysDir, o.name),
        name: o.name,
        recommended: o.name === chosen.name,
      }))
      const chosenPath = joinPath(overlaysDir, chosen.name)
      const hasK = (await scanner.getFirstFile(chosenPath, KUSTOMIZATION_FILES)) !== null
      return {
        path: chosenPath,
        renderer: hasK ? 'kustomize' : 'raw',
        ...(candidates.length > 1 ? { overlayCandidates: candidates } : {}),
      }
    }
  }
  return { path: k8s.dir, renderer: k8s.hasKustomization ? 'kustomize' : 'raw' }
}

/** Infer the URL source from the manifest kinds (HTTPRoute → Gateway → Ingress → LB Service). */
function inferUrlSource(scan: ManifestScan): KubernetesUrlSource | undefined {
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

function inferImageOverrides(scan: ManifestScan): KubernetesImageOverride[] {
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

async function inferHelmReleases(
  scanner: Scanner,
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
                ? `Proposed ${releases.length} helm release(s) from ${joinPath(dir, helmfile.name)}; review charts/versions before applying.${unpinned > 0 ? ` ${unpinned} release(s) had an unpinned version and were skipped.` : ''}`
                : `Found ${joinPath(dir, helmfile.name)} but its release versions aren't pinned — pin them to a semver to enable.`,
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
                ? `Proposed ${releases.length} helm release(s) from ${joinPath(dir, chart.name)} dependencies; review before applying.`
                : `Found ${joinPath(dir, chart.name)} dependencies but their versions aren't pinned to a semver.`,
          },
        }
      }
    }
  }
  return { releases: [], note: null }
}

/** The last path segment of a repo-relative dir; `''` (the repo root) is rendered as `.`. */
function dirLabel(dir: string): string {
  return dir === '' ? '.' : (dir.split('/').pop() ?? dir)
}

/**
 * Build the compose-service picker when a compose file declares MORE THAN ONE service. Pre-selects
 * the service whose key matches the service directory's basename, else the first declared service.
 * One/zero services ⇒ `undefined` (no picker).
 */
function buildComposeServiceCandidates(
  compose: ComposeHit,
  serviceBasename: string,
): ProvisioningComposeServiceCandidate[] | undefined {
  if (compose.services.length <= 1) return undefined
  const recommendedKey = compose.services.includes(serviceBasename)
    ? serviceBasename
    : compose.services[0]!
  return compose.services.map((service) => ({
    composePath: compose.path,
    service,
    recommended: service === recommendedKey,
  }))
}

function composeRecommendation(
  compose: ComposeHit,
  serviceBasename: string,
  kubernetesAlsoExists = false,
): ProvisioningRecommendation {
  const notes: ProvisioningDetectionNote[] = [
    {
      field: 'provisionType',
      confidence: 'high',
      message: `Detected a Docker Compose file at ${compose.path}.`,
    },
  ]
  // Symmetric to the kubernetes path's `compose` note: when we recommend compose because it's
  // the selected tab but k8s manifests also exist, say so (the user can switch).
  if (kubernetesAlsoExists) {
    notes.push({
      field: 'kubernetes',
      confidence: 'low',
      message:
        'Kubernetes manifests also exist in this repo; recommending docker-compose because it is your selected provision type. Switch to kubernetes if that is the test target.',
    })
  }
  const composeServiceCandidates = buildComposeServiceCandidates(compose, serviceBasename)
  if (composeServiceCandidates) {
    const rec = composeServiceCandidates.find((s) => s.recommended)
    notes.push({
      field: 'composeService',
      confidence: 'low',
      message: `The compose file declares ${composeServiceCandidates.length} services; pre-selected "${rec?.service ?? composeServiceCandidates[0]!.service}" for this block. The file is the deploy target — the service choice is advisory; pick another if that's wrong.`,
    })
  }
  return {
    detected: true,
    provisioning: { type: 'docker-compose', composePath: compose.path },
    ...(composeServiceCandidates ? { composeServiceCandidates } : {}),
    notes,
  }
}

function noneRecommendation(): ProvisioningRecommendation {
  return {
    detected: false,
    provisioning: { type: 'infraless' },
    notes: [
      {
        field: 'provisionType',
        confidence: 'high',
        message:
          'No Kubernetes manifests or Docker Compose file were found — recommending no infrastructure. Set a provision type manually if this service deploys.',
      },
    ],
  }
}

interface KubernetesBuildOptions {
  /** The service directory's basename, for compose-service pre-selection. */
  serviceBasename: string
  /** A co-existing compose file, surfaced as a "switch to compose" hint. */
  compose: ComposeHit | null
  /** Root-shared monorepo deploy slices to surface as a picker. */
  serviceDirCandidates?: ProvisioningServiceDirCandidate[]
  /**
   * When the chosen manifests came FROM a root-shared slice, the slice — so the note is
   * high-confidence ("found in the shared deploy dir") rather than the low-confidence
   * "manifests may ALSO live in a shared root" hint attached alongside a colocated pick.
   */
  chosenSlice?: ProvisioningServiceDirCandidate
}

/**
 * Build the full kubernetes recommendation from the collected `roots` (roots[0] is the chosen one).
 * `lookupRoot` is the base directory used for the helm + `.env.example` lookups (the service root for
 * a colocated pick, the repo root for a shared-slice pick). Surfaces sibling roots as
 * `manifestRootCandidates`, overlays as `overlayCandidates`, and any monorepo slices as
 * `serviceDirCandidates` — none auto-applied beyond the pre-selected one.
 */
async function buildKubernetesRecommendation(
  scanner: Scanner,
  roots: KubernetesRoot[],
  lookupRoot: string,
  opts: KubernetesBuildOptions,
): Promise<ProvisioningRecommendation> {
  const notes: ProvisioningDetectionNote[] = []
  const chosen = roots[0]!

  if (opts.chosenSlice) {
    notes.push({
      field: 'serviceDir',
      confidence: opts.chosenSlice.recommended ? 'high' : 'low',
      // Only claim a name match when the slice actually matched the service basename; otherwise it's
      // the first slice that happened to hold manifests, so don't overstate the confidence.
      message: opts.chosenSlice.recommended
        ? `Found this service's manifests in the shared deploy directory ${opts.chosenSlice.path} (matched "${opts.chosenSlice.name}"). Pick a different slice below if that's wrong.`
        : `Used manifests from the shared deploy directory ${opts.chosenSlice.path} (no slice matched this service's name). Pick a different slice below if that's wrong.`,
    })
  } else if (opts.serviceDirCandidates && opts.serviceDirCandidates.length > 0) {
    notes.push({
      field: 'serviceDir',
      confidence: 'low',
      message: `A root shared deploy directory also holds a slice named after this service; the colocated manifests were used. Pick the shared slice below if that is the deploy target instead.`,
    })
  }

  const { path, renderer, overlayCandidates } = await resolveManifestSource(scanner, chosen)

  // The colocated path stored on the service must be non-empty (the schema requires
  // minLength(1)), so represent the repo root as '.'. The raw `path` ('' = repo root for the
  // reader) is still what the internal scan calls below use to list/read files.
  const sourcePath = path || '.'

  const manifestSource: KubernetesManifestSource = {
    type: 'colocated',
    path: sourcePath,
    ...(renderer === 'kustomize' ? { renderer } : {}),
  }
  notes.push({
    field: 'renderer',
    confidence: 'high',
    message:
      renderer === 'kustomize'
        ? `Found a kustomization at ${sourcePath} ⇒ kustomize renderer (needs the container-backed deploy adapter).`
        : `No kustomization at ${sourcePath} ⇒ raw manifests.`,
  })

  // Several k8s roots resolved — surface the "which root" picker (complements the overlay picker).
  let manifestRootCandidates: ProvisioningManifestRootCandidate[] | undefined
  if (roots.length > 1) {
    manifestRootCandidates = roots.map((r, i) => ({
      // The recommended root uses the RESOLVED source path (which may be a kustomize overlay subdir,
      // e.g. `k8s/overlays/prenv`) so its chip matches `manifestSource.path` and stays highlighted —
      // and picking it re-applies that same overlay-resolved path rather than the bare root.
      path: i === 0 ? sourcePath : r.dir || '.',
      name: dirLabel(r.dir),
      renderer: r.hasKustomization ? ('kustomize' as const) : ('raw' as const),
      recommended: i === 0,
    }))
    notes.push({
      field: 'manifestRoot',
      confidence: 'low',
      message: `Found ${roots.length} manifest locations; pre-selected ${dirLabel(chosen.dir)}. Pick another below if that's wrong.`,
    })
  }

  if (overlayCandidates && overlayCandidates.length > 1) {
    const recommended = overlayCandidates.find((o) => o.recommended)
    notes.push({
      field: 'overlay',
      confidence: 'low',
      message: `Multiple overlays found; pre-selected ${recommended?.name ?? overlayCandidates[0]!.name} as the ephemeral one. Pick another if that's wrong.`,
    })
  }

  const scan = emptyScan()
  if (renderer === 'kustomize') {
    await walkKustomize(scanner, path, scan, 0)
  } else {
    await scanRawDir(scanner, path, scan)
  }

  const urlSource = inferUrlSource(scan)
  if (urlSource) {
    notes.push({
      field: 'url',
      confidence: 'high',
      message: `Inferred the environment URL source (${urlSource.source}) from the manifest kinds. The workspace kube handler owns this — apply it there.`,
    })
  }

  let namespace: string | undefined
  if (scan.namespaces.length > 0) {
    namespace = scan.namespaces[0]
    notes.push({
      field: 'namespace',
      confidence: 'high',
      message: `Manifests pin namespace "${namespace}" — recommend honoring it (leave the handler's namespaceTemplate empty).`,
    })
  }

  const images = inferImageOverrides(scan)
  if (images.length > 0) {
    notes.push({
      field: 'images',
      confidence: 'high',
      message: `Proposed ${images.length} image override(s) defaulting the tag to {{branch}}. Adjust the repo/tag as needed.`,
    })
  }

  const secretInjections: KubernetesSecretInjection[] = []
  if (scan.secretGenerator) {
    const envFilePath = joinPath(scan.secretGenerator.baseDir, scan.secretGenerator.envFile)
    const exampleDirs = [...new Set([scan.secretGenerator.baseDir, path, lookupRoot])]
    let keys: string[] = []
    for (const dir of exampleDirs) {
      const example = await scanner.getFirstFile(dir, ENV_EXAMPLE_FILES)
      if (example) {
        keys = parseEnvExampleKeys(example.content)
        if (keys.length > 0) break
      }
    }
    secretInjections.push({
      mode: 'generatorEnvFile',
      envFilePath,
      entries: keys.map((key) => ({ key, secretRef: { key } })),
    })
    notes.push({
      field: 'secretInjections',
      confidence: keys.length > 0 ? 'high' : 'low',
      message:
        keys.length > 0
          ? `A secretGenerator reads ${envFilePath}; proposed ${keys.length} key(s) from a .env example (you supply the values via the workspace secret bundle).`
          : `A secretGenerator reads ${envFilePath} but no .env.example was found — add the keys it needs manually.`,
    })
  }

  const helm = await inferHelmReleases(scanner, lookupRoot, chosen.dir)
  if (helm.note) notes.push(helm.note)

  if (opts.compose) {
    notes.push({
      field: 'compose',
      confidence: 'low',
      message: `A Docker Compose file also exists at ${opts.compose.path} (likely local dev). Recommending kubernetes; switch to docker-compose if that's the test target.`,
    })
  }

  if (scanner.exhausted) {
    notes.push({
      field: 'provisionType',
      confidence: 'low',
      message:
        "The repository scan was truncated (read budget reached); an unusual layout may have been missed. Browse the repo manually if your manifests weren't found.",
    })
  }

  const provisioning: ServiceProvisioning = {
    type: 'kubernetes',
    manifestSource,
    ...(images.length > 0 ? { images } : {}),
    ...(secretInjections.length > 0 ? { secretInjections } : {}),
    ...(helm.releases.length > 0 ? { helmReleases: helm.releases } : {}),
  }

  return {
    detected: true,
    provisioning,
    ...(urlSource ? { urlSource } : {}),
    ...(namespace ? { namespace } : {}),
    ...(overlayCandidates ? { overlayCandidates } : {}),
    ...(manifestRootCandidates ? { manifestRootCandidates } : {}),
    ...(opts.serviceDirCandidates && opts.serviceDirCandidates.length > 0
      ? { serviceDirCandidates: opts.serviceDirCandidates }
      : {}),
    notes,
  }
}

/**
 * Detect a recommended provisioning config for a service's repo. The search order honors the
 * user's selected tab via `options.prefer`: on the `docker-compose` tab a compose file wins when
 * present (even if Kubernetes manifests also exist); otherwise (incl. no preference) it prefers a
 * `kubernetes` recommendation (richer) when manifests are present. Either way it falls back to the
 * other kind, then to `infraless` when nothing is found.
 *
 * Monorepo-aware: when `options.directory` scopes to a service subdir, it checks BOTH the colocated
 * service dir AND — if nothing is colocated — the repo's ROOT SHARED deploy dirs for a per-service
 * slice keyed by the service name. Every inferred field carries a confidence note; ambiguous choices
 * (which overlay, which manifest root, which shared slice, which compose service) are surfaced as
 * candidates for the user to pick, never silently auto-applied beyond the pre-selected one.
 */
export async function detectKubernetesProvisioning(
  reader: ProvisioningRepoReader,
  options: DetectProvisioningOptions = {},
): Promise<ProvisioningRecommendation> {
  const root = joinPath(options.directory ?? '')
  const repoScanEnabled = root !== ''
  const serviceBasename = root.split('/').pop() ?? ''
  const scanner = new Scanner(reader, options.gitRef)

  const roots = await collectKubernetesRoots(scanner, root)
  const compose = await findCompose(scanner, root)

  // Honor the selected tab: on docker-compose, recommend the compose file first (noting any
  // co-existing k8s manifests). Falls through to kubernetes when the user is on compose but no
  // compose file exists. With no preference (or any non-compose tab) we keep the historical
  // kubernetes-first order.
  if (options.prefer === 'docker-compose' && compose) {
    return composeRecommendation(compose, serviceBasename, roots.length > 0)
  }

  // Colocated k8s manifests win (highest confidence). In a monorepo, ALSO surface a root-shared
  // per-service slice as a low-confidence "this might be the deploy target instead" hint — but ONLY
  // when a slice actually matches THIS service's name. Surfacing every unrelated `deploy/*` child
  // here is pure noise (the colocated manifests are already the confident pick).
  if (roots.length > 0) {
    const lowerBasename = serviceBasename.toLowerCase()
    const matchingHint = repoScanEnabled
      ? (await findServiceDeployCandidates(scanner, serviceBasename)).filter(
          (c) => c.name.toLowerCase() === lowerBasename,
        )
      : []
    return buildKubernetesRecommendation(scanner, roots, root, {
      serviceBasename,
      compose,
      ...(matchingHint.length > 0 ? { serviceDirCandidates: matchingHint } : {}),
    })
  }

  // No colocated manifests. In a monorepo, look for THIS service's slice in a root shared-deploy dir
  // (e.g. `deploy/<service>`), preferring the basename-matched slice(s).
  if (repoScanEnabled) {
    const slices = await findServiceDeployCandidates(scanner, serviceBasename)
    if (slices.length > 0) {
      const ordered = [...slices].sort((a, b) => Number(b.recommended) - Number(a.recommended))
      for (const slice of ordered) {
        const sliceRoots = await collectKubernetesRoots(scanner, slice.path)
        if (sliceRoots.length > 0) {
          return buildKubernetesRecommendation(scanner, sliceRoots, '', {
            serviceBasename,
            compose,
            serviceDirCandidates: slices,
            chosenSlice: slice,
          })
        }
      }
      // Slices exist but none resolved to real manifests. Only pre-select a k8s config when a slice
      // actually matches THIS service's name (`ordered[0]` is the recommended one, if any): a
      // basename match is a strong signal the slice is ours even if our heuristics didn't spot the
      // manifests. Without a name match we do NOT fabricate a kubernetes pick at an arbitrary,
      // unconfirmed dir — fall through to compose / none instead.
      const chosen = ordered[0]!
      if (chosen.recommended && !compose) {
        return {
          detected: true,
          provisioning: {
            type: 'kubernetes',
            manifestSource: { type: 'colocated', path: chosen.path },
          },
          serviceDirCandidates: slices,
          notes: [
            {
              field: 'serviceDir',
              confidence: 'low',
              message: `Matched a shared deploy slice by name (${chosen.path}) but couldn't confirm Kubernetes manifests inside it. Pre-selected it; verify the path or pick a different slice below.`,
            },
          ],
        }
      }
    }
  }

  if (compose) return composeRecommendation(compose, serviceBasename)
  return noneRecommendation()
}

export interface DetectCustomManifestOptions {
  /** Service subdirectory within the repo (monorepo); absent/'' ⇒ the repo root. */
  directory?: string
  /** Git ref to read at; absent ⇒ the reader's default branch. */
  gitRef?: string
  /** The custom-manifest-type id the service pins (echoed back on the recommendation). */
  manifestId?: string
  /** The selected custom type's default manifest path (complete path, or a bare filename). */
  defaultPath?: string
  /** The service's CURRENT `manifestPath`, if any — kept as-is when it already resolves. */
  currentPath?: string
}

/**
 * Detect the in-repo path of a `custom` service's manifest, read CHECKOUT-FREE. Monorepo-aware:
 * the search is rooted at the service subtree (`options.directory`) or the repo root. Rules:
 *
 * 1. If `currentPath` already points at an existing file, KEEP it (nothing changes).
 * 2. Otherwise, resolve from `defaultPath`:
 *    - exact `<root>/<defaultPath>` (the complete relative path with filename); else
 *    - when `defaultPath` is a bare filename (no `/`), also check ONE level deep — the same file
 *      inside each immediate child directory of the root; else
 *    - fall back to the default location (`<root>/<defaultPath>`), noting it wasn't found (it
 *      will be created when the manifest is generated).
 *
 * Never throws / never persists; the SPA confirms the prefilled `manifestPath`.
 */
export async function detectCustomManifest(
  reader: ProvisioningRepoReader,
  options: DetectCustomManifestOptions = {},
): Promise<ProvisioningRecommendation> {
  const root = joinPath(options.directory ?? '')
  const scanner = new Scanner(reader, options.gitRef)
  const manifestIdPart = options.manifestId ? { manifestId: options.manifestId } : {}
  const rec = (
    detected: boolean,
    manifestPath: string | undefined,
    note: ProvisioningDetectionNote,
  ): ProvisioningRecommendation => ({
    detected,
    provisioning: {
      type: 'custom',
      ...manifestIdPart,
      ...(manifestPath ? { manifestPath } : {}),
    },
    notes: [note],
  })

  // 1. An existing, accurate current value wins — don't churn a working path.
  const currentPath = options.currentPath?.trim()
  if (currentPath && (await scanner.getFile(currentPath)) !== null) {
    return rec(true, currentPath, {
      field: 'manifestPath',
      confidence: 'high',
      message: `The current manifest path (${currentPath}) already points to a file in the repo — kept unchanged.`,
    })
  }

  const defaultPath = options.defaultPath?.trim()
  if (!defaultPath) {
    return rec(false, currentPath || undefined, {
      field: 'manifestPath',
      confidence: 'low',
      message:
        'This custom manifest type declares no default path, so there is nothing to auto-detect. Enter the manifest path manually.',
    })
  }

  // 2a. Exact: the complete relative path (with filename) under the service subtree / repo root.
  const exact = joinPath(root, defaultPath)
  if ((await scanner.getFile(exact)) !== null) {
    return rec(true, exact, {
      field: 'manifestPath',
      confidence: 'high',
      message: `Found the custom manifest at ${exact} (the default path).`,
    })
  }

  // 2b. Bare filename ⇒ also look one level deep, inside each immediate child directory.
  if (!defaultPath.includes('/')) {
    for (const entry of await scanner.listDir(root)) {
      if (entry.type !== 'dir') continue
      const nested = joinPath(entry.path, defaultPath)
      if ((await scanner.getFile(nested)) !== null) {
        return rec(true, nested, {
          field: 'manifestPath',
          confidence: 'high',
          message: `Found ${defaultPath} one level deep at ${nested}.`,
        })
      }
    }
  }

  // 2c. Not found anywhere — pre-fill the default LOCATION so "generate" writes there.
  return rec(false, exact, {
    field: 'manifestPath',
    confidence: 'low',
    message: `No custom manifest found; pre-filled the default location ${exact}. It will be created when you generate the manifest.`,
  })
}
