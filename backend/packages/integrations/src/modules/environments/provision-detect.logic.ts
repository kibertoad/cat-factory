import type {
  KubernetesHelmRelease,
  KubernetesImageOverride,
  KubernetesManifestSource,
  KubernetesRenderer,
  KubernetesSecretInjection,
  KubernetesUrlSource,
  ProvisioningDetectionNote,
  ProvisioningOverlayCandidate,
  ProvisioningRecommendation,
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
}

const PINNED_SEMVER = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const KUSTOMIZATION_FILES = ['kustomization.yaml', 'kustomization.yml', 'Kustomization']
const COMPOSE_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml']
// Directories (relative to the service root) commonly holding the deploy manifests.
const K8S_DIR_CANDIDATES = [
  '',
  'k8s',
  'kubernetes',
  'deploy',
  'deployment',
  'manifests',
  '.k8s',
  'ops/k8s',
  'infra/k8s',
  'infra/kubernetes',
]
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
// Bounds the total reads so a pathological repo can't fan out unboundedly.
const READ_BUDGET = 80
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

async function findKubernetesRoot(scanner: Scanner, root: string): Promise<KubernetesRoot | null> {
  for (const candidate of K8S_DIR_CANDIDATES) {
    const dir = joinPath(root, candidate)
    const entries = await scanner.listDir(dir)
    if (entries.length === 0) continue
    const hasKustomization = entries.some(
      (e) => e.type !== 'dir' && KUSTOMIZATION_FILES.includes(e.name),
    )
    const hasOverlays = entries.some((e) => e.type === 'dir' && e.name === 'overlays')
    const hasBase = entries.some(
      (e) => e.type === 'dir' && (e.name === 'base' || e.name === 'bases'),
    )
    if (hasKustomization || hasOverlays || hasBase) {
      return { dir, hasOverlays, hasKustomization }
    }
    // No kustomize markers — accept the dir only if it holds an actual k8s manifest.
    for (const entry of entries) {
      if (entry.type === 'dir' || !isYamlFile(entry.name)) continue
      const content = await scanner.getFile(joinPath(dir, entry.name))
      const looksLikeManifest =
        content !== null &&
        parseDocs(content).some((d) => asString(d.kind) && asString(d.apiVersion))
      if (looksLikeManifest) return { dir, hasOverlays: false, hasKustomization: false }
    }
  }
  return null
}

async function findComposeFile(scanner: Scanner, root: string): Promise<string | null> {
  const entries = await scanner.listDir(root)
  const names = new Set(entries.filter((e) => e.type !== 'dir').map((e) => e.name))
  for (const candidate of COMPOSE_FILES) {
    if (names.has(candidate)) return joinPath(root, candidate)
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

function composeRecommendation(composePath: string): ProvisioningRecommendation {
  return {
    detected: true,
    provisioning: { type: 'docker-compose', composePath },
    notes: [
      {
        field: 'provisionType',
        confidence: 'high',
        message: `Detected a Docker Compose file at ${composePath}.`,
      },
    ],
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

/**
 * Detect a recommended provisioning config for a service's repo. Prefers a `kubernetes`
 * recommendation (richer) when manifests are present, falls back to `docker-compose` when only
 * a compose file exists, else `infraless`. Every inferred field carries a confidence note;
 * ambiguous choices (overlay, helm) are surfaced as low-confidence candidates, never auto-applied.
 */
export async function detectKubernetesProvisioning(
  reader: ProvisioningRepoReader,
  options: DetectProvisioningOptions = {},
): Promise<ProvisioningRecommendation> {
  const root = joinPath(options.directory ?? '')
  const scanner = new Scanner(reader, options.gitRef)

  const k8s = await findKubernetesRoot(scanner, root)
  const composePath = await findComposeFile(scanner, root)

  if (!k8s) {
    return composePath ? composeRecommendation(composePath) : noneRecommendation()
  }

  const notes: ProvisioningDetectionNote[] = []
  const { path, renderer, overlayCandidates } = await resolveManifestSource(scanner, k8s)

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
    const exampleDirs = [...new Set([scan.secretGenerator.baseDir, path, root])]
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

  const helm = await inferHelmReleases(scanner, root, k8s.dir)
  if (helm.note) notes.push(helm.note)

  if (composePath) {
    notes.push({
      field: 'compose',
      confidence: 'low',
      message: `A Docker Compose file also exists at ${composePath} (likely local dev). Recommending kubernetes; switch to docker-compose if that's the test target.`,
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
    notes,
  }
}
