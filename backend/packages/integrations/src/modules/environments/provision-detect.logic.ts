import type {
  KubernetesManifestSource,
  KubernetesRenderer,
  KubernetesSecretInjection,
  ProvisionType,
  ProvisioningDetectionNote,
  ProvisioningManifestRootCandidate,
  ProvisioningOverlayCandidate,
  ProvisioningRecommendation,
  ProvisioningServiceDirCandidate,
  ServiceProvisioning,
  SharedStackRecommendation,
} from '@cat-factory/contracts'
import { BudgetedRepoScanner, joinRepoPath } from '@cat-factory/kernel'
import { RepoReadError } from './repo-read-error.js'
import { asArray, asString, isYamlFile, parseOne } from './provision-detect.yaml.js'
import {
  type DetectionConventions,
  type ProvisioningRepoReader,
  READ_BUDGET,
  withExtras,
} from './provision-detect.contract.js'
import {
  buildComposeRecommendation,
  collectComposeFiles,
  collectEnvFileTemplates,
  type ComposeHit,
  findCompose,
} from './provision-detect.compose.js'
import {
  emptyScan,
  inferImageOverrides,
  inferHelmReleases,
  inferUrlSource,
  KUSTOMIZATION_FILES,
  type ManifestScan,
  parseManifestDocs,
  scanRawDir,
  walkKustomize,
} from './provision-detect.kubernetes.js'

// ---------------------------------------------------------------------------
// Per-service provisioning AUTO-DETECTION (slice 11): a deterministic, pure-TS heuristic
// that proposes a NON-BINDING recommended `kubernetes` (or `docker-compose`) provisioning
// config from a service's repo, read CHECKOUT-FREE over a minimal RepoFiles-shaped reader.
// No LLM, no clone — just targeted directory listings + YAML parsing. The user always
// confirms/edits; nothing here is applied silently. Mirrors the spirit of the compose
// autodiscovery: high-confidence facts are inferred deterministically; ambiguous ones
// (which overlay is the ephemeral one, which helm releases) are surfaced as candidates with
// a hint rather than guessed. See docs/initiatives/per-service-provision-types.md (slice 11).
//
// This module owns the KUBERNETES half plus the two entry points that choose between the two
// provision types. The compose / stack-recipe half lives in `provision-detect.compose.ts` and
// the contract all the sibling detectors share in `provision-detect.contract.ts`; both are
// re-exported here so every existing importer reaches them unchanged.
// ---------------------------------------------------------------------------

export {
  type DetectionConventions,
  type ProvisioningRepoReader,
  READ_BUDGET,
} from './provision-detect.contract.js'

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
  /** Deployment-level extensions to the built-in file-name/directory conventions (additive). */
  conventions?: DetectionConventions
}

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
// Top-level directories a monorepo commonly parks its shared DEPLOY manifests under, used for the
// per-service slice search (when a service subdir has no colocated manifests). Broader than a single
// name because orgs differ: `deploy` vs `deployment(s)`, `k8s` vs `kubernetes`, GitOps roots
// (`gitops`/`argocd`/`flux`). Deliberately excludes `apps/` — almost always the SOURCE tree, so a
// service whose manifests really live under `apps/<svc>` is covered by the colocated scan instead.
const SHARED_DEPLOY_ROOTS = [
  'deploy',
  'deployment',
  'deployments',
  'k8s',
  'kubernetes',
  '.k8s',
  'manifests',
  'infra',
  'infrastructure',
  'ops',
  'gitops',
  'argocd',
  'flux',
  '.deploy',
  'chart',
  'charts',
  'helm',
]
// Structural layer dirs a monorepo nests per-service slices UNDER, inside a shared deploy root
// (`deployment/k8s/base/services/<svc>`, `manifests/overlays/pre/<svc>`, `k8s/apps/<svc>`). The
// layered slice search descends THROUGH these — and through env-ranked overlay names (see
// `OVERLAY_RANK`) — looking for a child whose basename is the service, instead of only checking a
// shared root's immediate children. This is what generalizes detection across nesting conventions.
const SHARED_DEPLOY_LAYER_DIRS = new Set([
  'base',
  'bases',
  'services',
  'apps',
  'components',
  'overlays',
  'overlay',
  'env',
  'envs',
  'environments',
  'k8s',
  'kubernetes',
])
// Bounds the recursive slice search so a pathological monorepo can't fan out unboundedly.
const MAX_SHARED_DEPLOY_DEPTH = 5
const MAX_SHARED_DEPLOY_DIRS = 80
// The most k8s roots we collect as candidates (bounds the candidate list + the reads it triggers).
const MAX_MANIFEST_ROOTS = 6
// Overlay/environment names ranked most→least likely to be the ephemeral/preview environment. Also
// the vocabulary the `serviceManifestPaths` `{env}` placeholder expands across. Deliberately broad —
// orgs name their preview env many ways (`prenv`/`preview`/`pre`/`pr`/`review`/`ephemeral`/…); the
// rank only decides which is pre-selected when SEVERAL overlays coexist.
const OVERLAY_RANK = [
  'prenv',
  'preview',
  'pre',
  'pr',
  'review',
  'ephemeral',
  'eph',
  'sandbox',
  'sbx',
  'dev',
  'development',
  'int',
  'integration',
  'staging',
  'stage',
  'uat',
  'test',
  'testing',
  'qa',
  'demo',
]
const ENV_EXAMPLE_FILES = ['.env.example', '.env.sample', '.env.template', '.env.dist']

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

/**
 * A k8s manifest root: the directory, whether it carries an `overlays/` tree, whether it has a
 * kustomization, and whether that kustomization is a Kustomize `Component`. A Component
 * (`kind: Component`, `kustomize.config.k8s.io`) is NOT independently deployable — `kustomize build`
 * rejects it; it exists only to be pulled into an aggregating overlay via `components:`. So a
 * Component root is ranked below a standalone one, and when it's the best match the detector prefers
 * the overlay that aggregates it (see `resolveComponentAggregator`).
 */
interface KubernetesRoot {
  dir: string
  hasOverlays: boolean
  hasKustomization: boolean
  isComponent: boolean
}

/** True when a parsed kustomization declares `kind: Component` (a non-standalone Kustomize component). */
function isKustomizeComponent(kustomizationContent: string): boolean {
  const parsed = parseOne(kustomizationContent)
  return parsed !== null && asString(parsed.kind) === 'Component'
}

/**
 * Decide whether `dir` (with its already-listed `entries`) is a k8s manifest root: it is when it
 * carries a kustomization / an `overlays/` or `base(s)/` subtree, or — lacking those markers — at
 * least one YAML file that parses as a real Kubernetes manifest (see {@link isKubernetesManifestDoc};
 * a Backstage `catalog-info.yaml` and other non-cluster `kind`+`apiVersion` decoys do NOT qualify).
 */
async function evaluateK8sDir(
  scanner: BudgetedRepoScanner,
  dir: string,
  entries: { name: string; type: string; path: string }[],
): Promise<KubernetesRoot | null> {
  const kustomizationEntry = entries.find(
    (e) => e.type !== 'dir' && KUSTOMIZATION_FILES.includes(e.name),
  )
  const hasKustomization = kustomizationEntry !== undefined
  const hasOverlays = entries.some((e) => e.type === 'dir' && e.name === 'overlays')
  const hasBase = entries.some((e) => e.type === 'dir' && (e.name === 'base' || e.name === 'bases'))
  if (hasKustomization || hasOverlays || hasBase) {
    let isComponent = false
    if (kustomizationEntry) {
      const content = await scanner.getFile(joinRepoPath(dir, kustomizationEntry.name))
      isComponent = content !== null && isKustomizeComponent(content)
    }
    return { dir, hasOverlays, hasKustomization, isComponent }
  }
  // No kustomize markers — accept the dir only if it holds an actual k8s manifest.
  for (const entry of entries) {
    if (entry.type === 'dir' || !isYamlFile(entry.name)) continue
    const content = await scanner.getFile(joinRepoPath(dir, entry.name))
    if (content !== null && parseManifestDocs(content).length > 0) {
      return { dir, hasOverlays: false, hasKustomization: false, isComponent: false }
    }
  }
  return null
}

/**
 * Collect EVERY k8s manifest root under `root` (in `K8S_DIR_CANDIDATES` order — common names first),
 * descending one level into wrapper dirs. Bounded by `MAX_MANIFEST_ROOTS` + the read budget. The
 * first entry is the highest-ranked (the one the detector prefills); the rest drive the "which root"
 * picker. Dedupes by directory so a dir reachable both directly and as a nested child isn't listed twice.
 */
async function collectKubernetesRoots(
  scanner: BudgetedRepoScanner,
  root: string,
): Promise<KubernetesRoot[]> {
  const found: KubernetesRoot[] = []
  const seen = new Set<string>()
  const add = (r: KubernetesRoot): void => {
    if (seen.has(r.dir)) return
    seen.add(r.dir)
    found.push(r)
  }
  for (const candidate of K8S_DIR_CANDIDATES) {
    if (found.length >= MAX_MANIFEST_ROOTS) break
    const dir = joinRepoPath(root, candidate)
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
      const nestedDir = joinRepoPath(dir, entry.name)
      const nested = await evaluateK8sDir(scanner, nestedDir, await scanner.listDir(nestedDir))
      if (nested) add(nested)
    }
  }
  // Standalone roots rank above Kustomize Components (a Component can't be built on its own), keeping
  // the original discovery order within each group (a stable partition). So `found[0]` — the prefilled
  // pick — is never a bare Component when a standalone sibling exists.
  return found.sort((a, b) => Number(a.isComponent) - Number(b.isComponent))
}

// Deploy/env decoration tokens that legitimately SUFFIX a service's own slice dir (`<svc>-deploy`,
// `<svc>-k8s`, `<svc>-staging`). A service-as-PREFIX affix match is accepted ONLY when the trailing
// token is one of these — the affix tier must NOT let `backend` match a DIFFERENT sibling service
// `backend-acme` (whose trailing `acme` is not a deploy word). A service-as-SUFFIX match
// (`<namespace>-<svc>`, e.g. `acme-api`) is org/namespace decoration where the prefix is arbitrary,
// so it stays accepted as-is.
const DEPLOY_DECORATION_TOKENS = new Set([
  'deploy',
  'deployment',
  'deployments',
  'k8s',
  'kubernetes',
  'kustomize',
  'manifests',
  'manifest',
  'chart',
  'charts',
  'helm',
  ...OVERLAY_RANK,
])

/**
 * How strongly a slice directory name identifies THIS service. 3 = exact, 2 = case-insensitive,
 * 1 = affix match (the service name plus ONE delimiter-bounded decoration segment), 0 = no match.
 *
 * The affix tier (1) is deliberately asymmetric so it catches real decoration without matching an
 * unrelated sibling whose name merely shares a prefix or suffix:
 *
 * - `<namespace>-<svc>` — the service is the TRAILING segment (`acme-api` for `api`). The leading
 *   segment is an arbitrary org/namespace prefix, so any prefix is accepted.
 * - `<svc>-<token>` — the service is the LEADING segment (`api-deploy` for `api`). Here the trailing
 *   segment is only accepted when it is a known deploy/env decoration word ({@link DEPLOY_DECORATION_TOKENS});
 *   this is what stops `backend` matching the DIFFERENT sibling service `backend-acme`.
 *
 * (Residual, accepted: a service that is itself the trailing segment of a longer sibling — `acme`
 * vs `backend-acme` — still tier-1 matches via the namespace-prefix rule, since we can't tell an
 * org prefix from another service's name without cross-referencing sibling dirs. That is far rarer
 * than the shared-prefix case above and only ever ADDS a candidate to the picker.)
 */
function serviceNameMatchTier(sliceName: string, serviceBasename: string): number {
  if (!serviceBasename) return 0
  if (sliceName === serviceBasename) return 3
  const a = sliceName.toLowerCase()
  const b = serviceBasename.toLowerCase()
  if (a === b) return 2
  for (const delim of ['-', '_']) {
    // `<namespace><delim><svc>` — service is the trailing segment; the prefix is arbitrary.
    if (a.length > b.length + delim.length && a.endsWith(`${delim}${b}`)) return 1
    // `<svc><delim><token>` — service is the leading segment; the token must be a deploy/env word.
    if (
      a.startsWith(`${b}${delim}`) &&
      DEPLOY_DECORATION_TOKENS.has(a.slice(b.length + delim.length))
    )
      return 1
  }
  return 0
}

/**
 * Deploy-slice structural preference inferred from its path: a `base`/`services` slice is typically a
 * standalone Kustomization (higher), an `overlays`/`components` slice is usually a non-standalone
 * Component (lower). Only breaks ties between equally-named slices — the definitive standalone-vs-
 * component decision is made from the slice's own kustomization by {@link evaluateK8sDir}.
 */
function sliceStructuralScore(path: string): number {
  const segs = path.toLowerCase().split('/')
  let score = 0
  if (segs.includes('base') || segs.includes('bases') || segs.includes('services')) score += 2
  if (segs.includes('overlays') || segs.includes('overlay') || segs.includes('components'))
    score -= 2
  return score
}

// Top-level roots that UNAMBIGUOUSLY hold deploy manifests. A name-matched slice directly under one
// of these is a real slice; a match under an AMBIGUOUS root (`infra`/`ops`/`gitops`/`argocd`/`flux`/
// `charts`/`helm`, which just as often hold terraform/scripts/charts) is surfaced only when its path
// also carries a Kubernetes structural token — so a terraform `infra/<svc>` sibling isn't offered as
// a bogus manifest slice.
const STRONG_MANIFEST_ROOTS = new Set([
  'deploy',
  'deployment',
  'deployments',
  'k8s',
  'kubernetes',
  '.k8s',
  '.deploy',
  'manifests',
])

/**
 * Whether a name-matched slice path is manifest-shaped enough to surface (see {@link STRONG_MANIFEST_ROOTS}).
 * A match directly under an operator-configured `manifestDirs` root (`strongExtras`) always counts —
 * the operator has declared that root holds manifests, so it's never treated as an ambiguous sibling.
 */
function isManifestSlicePath(path: string, strongExtras: Set<string>): boolean {
  const segs = path.toLowerCase().split('/')
  const top = segs[0] ?? ''
  if (STRONG_MANIFEST_ROOTS.has(top) || strongExtras.has(top)) return true
  return segs.some(
    (s) =>
      SHARED_DEPLOY_LAYER_DIRS.has(s) || s === 'manifests' || s === 'k8s' || s === 'kubernetes',
  )
}

interface ServiceSlice {
  path: string
  name: string
  tier: number
  structural: number
}

/**
 * Locate THIS service's per-service manifest slice(s) in the repo's shared deploy roots — a bounded,
 * layered breadth-first descent that generalizes across nesting conventions: `deploy/<svc>`,
 * `deployment/k8s/base/services/<svc>`, `manifests/overlays/pre/<svc>`, `k8s/apps/<svc>`, and a
 * `<prefix>-<svc>` namespaced slice. From each shared deploy root it descends THROUGH the structural
 * layer dirs (`base`/`services`/`apps`/`overlays/<env>`/…) collecting only directories whose basename
 * MATCHES the service (name tier ≥ 1) — so the surfaced candidates are the handful that plausibly
 * belong to this service, not every unrelated sibling. Bounded by depth + a dir-listing cap + the read
 * budget. Returns them best-match-first (exact > ci > affix, then standalone > component), with the
 * best flagged `recommended`. `extraRoots` are deployment-configured additions (`conventions.manifestDirs`).
 */
async function findServiceManifestSlices(
  scanner: BudgetedRepoScanner,
  serviceBasename: string,
  extraRoots: string[] = [],
): Promise<ProvisioningServiceDirCandidate[]> {
  if (!serviceBasename) return []
  const matches: ServiceSlice[] = []
  const seenMatch = new Set<string>()
  const visited = new Set<string>()
  let listed = 0
  // Operator-configured roots are trusted as strong (a name match directly under one is a real slice).
  const strongExtras = new Set(extraRoots.map((r) => r.trim().toLowerCase()).filter(Boolean))
  // BFS frontier of (dir, depth). Seed with the shared roots (+ configured extras) at depth 0.
  const frontier: { dir: string; depth: number }[] = withExtras(
    SHARED_DEPLOY_ROOTS,
    extraRoots,
  ).map((dir) => ({ dir, depth: 0 }))
  while (frontier.length > 0) {
    if (listed >= MAX_SHARED_DEPLOY_DIRS) break
    const { dir, depth } = frontier.shift()!
    if (visited.has(dir)) continue
    visited.add(dir)
    const entries = await scanner.listDir(dir)
    if (entries.length === 0) continue
    listed++
    for (const entry of entries) {
      if (entry.type !== 'dir') continue
      const childPath = joinRepoPath(dir, entry.name)
      const tier = serviceNameMatchTier(entry.name, serviceBasename)
      if (tier > 0 && !seenMatch.has(childPath) && isManifestSlicePath(childPath, strongExtras)) {
        seenMatch.add(childPath)
        matches.push({
          path: childPath,
          name: entry.name,
          tier,
          structural: sliceStructuralScore(childPath),
        })
      }
      // Descend through structural-layer dirs and env-ranked overlay names (`overlays/pre`) so a slice
      // nested several layers deep still resolves. A name-matched dir is a leaf slice, not a layer, so
      // we don't descend into it (its own manifests are read later by `collectKubernetesRoots`).
      const isLayer =
        SHARED_DEPLOY_LAYER_DIRS.has(entry.name.toLowerCase()) ||
        rankOverlay(entry.name) < OVERLAY_RANK.length
      if (tier === 0 && isLayer && depth + 1 <= MAX_SHARED_DEPLOY_DEPTH) {
        frontier.push({ dir: childPath, depth: depth + 1 })
      }
    }
  }
  if (matches.length === 0) return []
  matches.sort(
    (a, b) => b.tier - a.tier || b.structural - a.structural || a.path.localeCompare(b.path),
  )
  return matches.map((m, i) => ({ path: m.path, name: m.name, recommended: i === 0 }))
}

/**
 * Resolve the aggregating overlay for a Kustomize Component slice — the overlay `kustomization.yaml`
 * (a real `Kustomization`) that pulls the component in via `components:`. A Component can't be built on
 * its own, so when a component slice is the chosen manifest source we recommend its aggregator instead.
 * Looks at the component dir's PARENT (the common `overlays/<env>/<component>` shape). Returns the
 * aggregator root, or null when none references it (then the caller keeps the component + warns).
 */
async function resolveComponentAggregator(
  scanner: BudgetedRepoScanner,
  componentDir: string,
): Promise<KubernetesRoot | null> {
  const componentBase = componentDir.split('/').pop() ?? componentDir
  const parent = componentDir.split('/').slice(0, -1).join('/')
  if (!parent) return null
  const kustomization = await scanner.getFirstFile(parent, KUSTOMIZATION_FILES)
  if (!kustomization) return null
  const parsed = parseOne(kustomization.content)
  if (!parsed || asString(parsed.kind) === 'Component') return null
  const references = asArray(parsed.components).some((c) => {
    const ref = asString(c)
    return ref !== undefined && (ref.split('/').pop() ?? ref) === componentBase
  })
  if (!references) return null
  return evaluateK8sDir(scanner, parent, await scanner.listDir(parent))
}

/**
 * Resolve an explicit house-layout {@link DetectionConventions.serviceManifestPaths} template to real
 * manifests — the deterministic escape hatch. Expands `{service}` (the service basename) and `{env}`
 * (tried across {@link OVERLAY_RANK}, most-ephemeral first), and returns the first expansion that IS a
 * manifest root. A template needing `{service}` is skipped when there's no service basename (a
 * repo-root scan). The probe is a single {@link evaluateK8sDir} on the EXACT expanded path (a template
 * points straight at the manifests dir), so it stays cheap even across many `{env}` expansions — never
 * the full sub-tree search. Returns null when no template resolves (the heuristic search then runs).
 */
async function resolveTemplatedManifestRoots(
  scanner: BudgetedRepoScanner,
  templates: string[],
  serviceBasename: string,
): Promise<{ roots: KubernetesRoot[]; path: string } | null> {
  for (const template of templates) {
    if (template.includes('{service}') && !serviceBasename) continue
    const withService = template.split('{service}').join(serviceBasename)
    const envValues = withService.includes('{env}') ? OVERLAY_RANK : ['']
    for (const env of envValues) {
      const path = joinRepoPath(withService.split('{env}').join(env))
      if (!path) continue
      const root = await evaluateK8sDir(scanner, path, await scanner.listDir(path))
      if (root) return { roots: [root], path }
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
  scanner: BudgetedRepoScanner,
  k8s: KubernetesRoot,
): Promise<{
  path: string
  renderer: KubernetesRenderer
  overlayCandidates?: ProvisioningOverlayCandidate[]
}> {
  if (k8s.hasOverlays) {
    const overlaysDir = joinRepoPath(k8s.dir, 'overlays')
    const overlays = (await scanner.listDir(overlaysDir)).filter((e) => e.type === 'dir')
    if (overlays.length > 0) {
      const ranked = [...overlays].sort((a, b) => rankOverlay(a.name) - rankOverlay(b.name))
      const chosen = ranked[0]!
      const candidates: ProvisioningOverlayCandidate[] = ranked.map((o) => ({
        path: joinRepoPath(overlaysDir, o.name),
        name: o.name,
        recommended: o.name === chosen.name,
      }))
      const chosenPath = joinRepoPath(overlaysDir, chosen.name)
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

/** The last path segment of a repo-relative dir; `''` (the repo root) is rendered as `.`. */
function dirLabel(dir: string): string {
  return dir === '' ? '.' : (dir.split('/').pop() ?? dir)
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
 * Surface the "which manifest root" picker when several k8s roots resolved (complements the overlay
 * picker), recording the note. Returns undefined (and pushes nothing) for a single root.
 */
function buildManifestRootCandidates(
  effectiveRoots: KubernetesRoot[],
  sourcePath: string,
  chosen: KubernetesRoot,
  notes: ProvisioningDetectionNote[],
): ProvisioningManifestRootCandidate[] | undefined {
  if (effectiveRoots.length <= 1) return undefined
  const manifestRootCandidates = effectiveRoots.map((r, i) => ({
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
    message: `Found ${effectiveRoots.length} manifest locations; pre-selected ${dirLabel(chosen.dir)}. Pick another below if that's wrong.`,
  })
  return manifestRootCandidates
}

/**
 * Resolve the secret injections for a kustomize `secretGenerator` (if any): find the first
 * `.env.example` across the generator/base/lookup dirs, map its keys to secret refs, and record the
 * confidence note. Returns [] (and pushes nothing) when the manifests declare no generator.
 */
async function buildSecretInjections(
  scanner: BudgetedRepoScanner,
  scan: ManifestScan,
  path: string,
  lookupRoot: string,
  notes: ProvisioningDetectionNote[],
): Promise<KubernetesSecretInjection[]> {
  const secretInjections: KubernetesSecretInjection[] = []
  if (scan.secretGenerator) {
    const envFilePath = joinRepoPath(scan.secretGenerator.baseDir, scan.secretGenerator.envFile)
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
  return secretInjections
}

/**
 * Build the full kubernetes recommendation from the collected `roots` (roots[0] is the chosen one).
 * `lookupRoot` is the base directory used for the helm + `.env.example` lookups (the service root for
 * a colocated pick, the repo root for a shared-slice pick). Surfaces sibling roots as
 * `manifestRootCandidates`, overlays as `overlayCandidates`, and any monorepo slices as
 * `serviceDirCandidates` — none auto-applied beyond the pre-selected one.
 */
/**
 * Resolve the deployable roots from `roots` (roots[0] is the chosen one). A Kustomize Component
 * isn't independently deployable (`kustomize build` rejects it), so if the chosen slice is one,
 * prefer the overlay that aggregates it (its `components:` parent); when no aggregator references
 * it, keep the component but warn. Pushes the explanatory note(s) onto `notes`.
 */
async function resolveDeployableRoots(
  scanner: BudgetedRepoScanner,
  roots: KubernetesRoot[],
  notes: ProvisioningDetectionNote[],
): Promise<{ effectiveRoots: KubernetesRoot[]; chosen: KubernetesRoot }> {
  let effectiveRoots = roots
  let chosen = effectiveRoots[0]!
  if (chosen.isComponent) {
    const aggregator = await resolveComponentAggregator(scanner, chosen.dir)
    if (aggregator) {
      notes.push({
        field: 'manifestRoot',
        confidence: 'high',
        message: `"${dirLabel(chosen.dir)}" is a Kustomize Component (not deployable on its own); using the overlay that aggregates it at ${aggregator.dir || '.'} instead.`,
      })
      effectiveRoots = [aggregator, ...effectiveRoots]
      chosen = aggregator
    } else {
      notes.push({
        field: 'manifestRoot',
        confidence: 'low',
        message: `"${dirLabel(chosen.dir)}" looks like a Kustomize Component, which \`kustomize build\` can't render on its own. Point the manifest source at the overlay that includes it (via \`components:\`).`,
      })
    }
  }
  return { effectiveRoots, chosen }
}

/**
 * Push the service-directory provenance note: which shared-deploy slice was matched (when
 * `opts.chosenSlice` is set), or — when only sibling slice candidates exist — that the colocated
 * manifests were used with the shared slice offered as an alternative.
 */
function pushServiceDirNote(
  notes: ProvisioningDetectionNote[],
  opts: KubernetesBuildOptions,
): void {
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
}

async function buildKubernetesRecommendation(
  scanner: BudgetedRepoScanner,
  roots: KubernetesRoot[],
  lookupRoot: string,
  opts: KubernetesBuildOptions,
): Promise<ProvisioningRecommendation> {
  const notes: ProvisioningDetectionNote[] = []
  const { effectiveRoots, chosen } = await resolveDeployableRoots(scanner, roots, notes)

  pushServiceDirNote(notes, opts)

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
  const manifestRootCandidates = buildManifestRootCandidates(
    effectiveRoots,
    sourcePath,
    chosen,
    notes,
  )

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

  const secretInjections = await buildSecretInjections(scanner, scan, path, lookupRoot, notes)

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
  const root = joinRepoPath(options.directory ?? '')
  const repoScanEnabled = root !== ''
  const serviceBasename = root.split('/').pop() ?? ''
  const scanner = new BudgetedRepoScanner(reader, READ_BUDGET, options.gitRef)

  const roots = await collectKubernetesRoots(scanner, root)
  const compose = await findCompose(scanner, root, options.conventions)

  // Honor the selected tab: on docker-compose, recommend the compose file first (noting any
  // co-existing k8s manifests). Falls through to kubernetes when the user is on compose but no
  // compose file exists. With no preference (or any non-compose tab) we keep the historical
  // kubernetes-first order.
  if (options.prefer === 'docker-compose' && compose) {
    return buildComposeRecommendation(
      scanner,
      root,
      compose,
      serviceBasename,
      roots.length > 0,
      options.conventions,
    )
  }

  // Escape hatch (highest confidence): an explicit house-layout `serviceManifestPaths` template maps
  // the service straight to its manifests, so it's tried BEFORE the heuristic search — a one-line
  // deployment config that makes a whole monorepo resolve deterministically.
  const templates = options.conventions?.serviceManifestPaths
  if (templates && templates.length > 0) {
    const templated = await resolveTemplatedManifestRoots(scanner, templates, serviceBasename)
    if (templated) {
      return buildKubernetesRecommendation(scanner, templated.roots, templated.path, {
        serviceBasename,
        compose,
      })
    }
  }

  const extraManifestDirs = options.conventions?.manifestDirs

  // Colocated k8s manifests win (highest confidence). In a monorepo, ALSO surface a root-shared
  // per-service slice as a low-confidence "this might be the deploy target instead" hint — but ONLY
  // when a slice actually matches THIS service's name. Surfacing every unrelated `deploy/*` child
  // here is pure noise (the colocated manifests are already the confident pick).
  if (roots.length > 0) {
    const lowerBasename = serviceBasename.toLowerCase()
    const matchingHint = repoScanEnabled
      ? (await findServiceManifestSlices(scanner, serviceBasename, extraManifestDirs)).filter(
          (c) => c.name.toLowerCase() === lowerBasename,
        )
      : []
    return buildKubernetesRecommendation(scanner, roots, root, {
      serviceBasename,
      compose,
      ...(matchingHint.length > 0 ? { serviceDirCandidates: matchingHint } : {}),
    })
  }

  // No colocated manifests. In a monorepo, look for THIS service's slice in the shared deploy dirs
  // (`deploy/<svc>`, `deployment/k8s/base/services/<svc>`, `overlays/<env>/<svc>`, …), preferring the
  // basename-matched slice(s).
  if (repoScanEnabled) {
    const slices = await findServiceManifestSlices(scanner, serviceBasename, extraManifestDirs)
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

  if (compose)
    return buildComposeRecommendation(
      scanner,
      root,
      compose,
      serviceBasename,
      false,
      options.conventions,
    )
  // Nothing detected. If that "nothing" is really "the repo couldn't be read" (the scan hit a
  // genuine read fault), raise it rather than falsely reporting an empty repo.
  if (scanner.readFault) throw new RepoReadError(scanner.readFault)
  return noneRecommendation()
}

export interface DetectSharedStackOptions {
  /** Subdirectory the compose stack lives in (monorepo); absent/'' ⇒ the repo root. */
  directory?: string
  /** Git ref to read at; absent ⇒ the reader's default branch. */
  gitRef?: string
  /** The repo basename, used as the suggested stack name when a stack is detected. */
  repoName?: string
  /** Deployment-level extensions to the built-in file-name/directory conventions (additive). */
  conventions?: DetectionConventions
}

/**
 * Detect a recommended SHARED-STACK config from a repo, read CHECKOUT-FREE over the same minimal
 * {@link ProvisioningRepoReader} the provisioning detector uses. A shared stack is just the
 * compose half of that scan (a shared stack has no Kubernetes analogue), narrowed to the fields
 * the shared-stack form carries:
 *
 * - `composeFiles` — the base compose file plus any `<stem>.override.ya?ml` auto-merge family
 *   (OS-specific overrides are NOT auto-layered; the user picks the one for their machine).
 * - `composeProfiles` — the `COMPOSE_PROFILES` the file declares (surfaced, not auto-enabled).
 * - `managedNetworks` — the `external: true` networks the compose references. A shared stack is
 *   responsible for creating + owning these (`docker network create`), which is exactly what an
 *   external network in the consumed compose means (the acme `acme-net` shape). A self-contained
 *   compose that defines all its dependencies internally declares no external network, so this is
 *   empty — the honest result (compose owns those networks; add one to expose it if you want).
 * - `envFiles` — committed `*-dist`/`*.example` templates to materialize before `up`.
 *
 * Every inferred field carries a confidence note. Nothing is auto-applied; the panel prefills the
 * form and the user confirms. A genuine read fault (auth/rate-limit/transport) throws
 * {@link RepoReadError}; a clean "no compose file here" returns `detected: false`.
 */
export async function detectSharedStack(
  reader: ProvisioningRepoReader,
  options: DetectSharedStackOptions = {},
): Promise<SharedStackRecommendation> {
  const root = joinRepoPath(options.directory ?? '')
  const scanner = new BudgetedRepoScanner(reader, READ_BUDGET, options.gitRef)
  const compose = await findCompose(scanner, root, options.conventions)
  if (!compose) {
    // Nothing compose-shaped. Distinguish "couldn't read the repo" from "read it, no compose".
    if (scanner.readFault) throw new RepoReadError(scanner.readFault)
    return {
      detected: false,
      composeFiles: [],
      composeProfiles: [],
      managedNetworks: [],
      envFiles: [],
      notes: [
        {
          field: 'provisionType',
          confidence: 'high',
          message:
            'No Docker Compose file was found in this repo — enter the stack’s compose files manually.',
        },
      ],
    }
  }

  const notes: ProvisioningDetectionNote[] = [
    {
      field: 'composeFiles',
      confidence: 'high',
      message: `Detected a Docker Compose file at ${compose.path}.`,
    },
  ]

  // Layer the base file + its `<stem>.override` auto-merge family; a lone file ⇒ just itself.
  const { composeFiles } = collectComposeFiles(compose)
  const files = composeFiles ?? [compose.path]
  if (composeFiles && composeFiles.length > 1) {
    notes.push({
      field: 'composeFiles',
      confidence: 'high',
      message: `Layered ${composeFiles.length} compose files: ${composeFiles.join(' → ')}.`,
    })
  }

  // External networks the compose expects to pre-exist ARE the networks a shared stack owns.
  const managedNetworks = compose.externalNetworks
  if (managedNetworks.length > 0) {
    notes.push({
      field: 'externalNetworks',
      confidence: 'high',
      message: `This stack’s compose references external network(s) it must create + own: ${managedNetworks.join(', ')}. Consumers attach to these.`,
    })
  } else {
    notes.push({
      field: 'externalNetworks',
      confidence: 'low',
      message:
        'The compose declares no external network; its services share compose-owned networks. Add a managed network only if consumers need to attach to this stack.',
    })
  }

  if (compose.profiles.length > 0) {
    notes.push({
      field: 'composeProfiles',
      confidence: 'low',
      message: `The compose file declares ${compose.profiles.length} profile(s): ${compose.profiles.join(', ')}. Enable the optional service groups this stack should run.`,
    })
  }

  const envFiles = await collectEnvFileTemplates(scanner, root, compose.dir, options.conventions)
  if (envFiles.length > 0) {
    notes.push({
      field: 'envFiles',
      confidence: 'low',
      message: `Found ${envFiles.length} env/config template(s) to materialize before up: ${envFiles
        .map((e) => `${e.template} → ${e.target}`)
        .join(', ')}.`,
    })
  }

  if (scanner.exhausted) {
    notes.push({
      field: 'provisionType',
      confidence: 'low',
      message:
        'The repository scan was truncated (read budget reached); an unusual layout may have been missed. Review the fields before saving.',
    })
  }

  return {
    detected: true,
    ...(options.repoName ? { name: options.repoName } : {}),
    composeFiles: files,
    composeProfiles: compose.profiles,
    managedNetworks,
    envFiles,
    notes,
  }
}
