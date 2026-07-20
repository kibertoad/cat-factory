import type {
  KubernetesHelmRelease,
  KubernetesImageOverride,
  KubernetesManifestSource,
  KubernetesRenderer,
  KubernetesSecretInjection,
  KubernetesUrlSource,
  ProvisionType,
  ProvisioningComposeFileCandidate,
  ProvisioningComposeServiceCandidate,
  ProvisioningDetectionNote,
  ProvisioningManifestRootCandidate,
  ProvisioningOverlayCandidate,
  ProvisioningProfileCandidate,
  ProvisioningRecommendation,
  ProvisioningRepoCliHint,
  ProvisioningSeedDumpCandidate,
  ProvisioningServiceDirCandidate,
  RecipeEnvFile,
  ServiceProvisioning,
  SharedStackRecommendation,
  StackRecipe,
} from '@cat-factory/contracts'
import type { RepoScanEntry } from '@cat-factory/kernel'
import { BudgetedRepoScanner, joinRepoPath } from '@cat-factory/kernel'
import { parse as parseYaml, parseAllDocuments } from 'yaml'
import {
  extractComposeProfiles,
  extractExternalNetworks,
  hasBuildDirective,
} from '../compose/compose-environment.logic.js'
import { RepoReadError } from './repo-read-error.js'

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
 * structurally, and a test supplies an in-memory fake. A MISSING path yields `null` / `[]`, so the
 * heuristics degrade gracefully on partial repos. A genuine read fault (auth/permission revoked,
 * rate limit, transport error) may THROW — the real GitHub/GitLab reader throws on any non-404
 * status. The {@link BudgetedRepoScanner} tolerates that (records it, keeps scanning best-effort)
 * so a transient fault mid-scan can't lose an otherwise-good result; see its `readFault`.
 */
export interface ProvisioningRepoReader {
  getFile(path: string, gitRef?: string): Promise<{ content: string } | null>
  listDirectory(
    path: string,
    gitRef?: string,
  ): Promise<{ name: string; type: string; path: string }[]>
}

/**
 * Deployment-level EXTENSIONS to the built-in detection conventions, so an org whose repos follow
 * house conventions the defaults don't name (a compose file called `stack.yml`, seeds under
 * `ops/seeds/`, …) can broaden detection WITHOUT a code edit — set on the deployment config and
 * threaded into the detectors as {@link DetectProvisioningOptions.conventions}. Every field is
 * ADDITIVE: the built-in list always wins where it and an extra overlap, and the canonical compose
 * names still take priority (extras are appended lowest-priority), so widening the search can only
 * find MORE, never change what a default-shaped repo already resolves to. Absent ⇒ exactly the
 * built-in behaviour.
 */
export interface DetectionConventions {
  /** Extra compose file base names to recognize, appended AFTER the canonical set (lowest priority). */
  composeFiles?: string[]
  /** Extra directories (repo-relative) to search for a compose file, beyond `deploy`/`docker`/…. */
  composeDirs?: string[]
  /** Extra directories a SQL seed dump may live under, beyond `deployment`/`seed`/`db`/…. */
  seedDirs?: string[]
  /** Extra directories an env/config template may sit in, beyond the compose dir + `config`/`env`/…. */
  envTemplateDirs?: string[]
  /**
   * Extra top-level directories to treat as shared DEPLOY-MANIFEST roots for the monorepo
   * per-service slice search, beyond the built-in `deploy`/`deployment`/`k8s`/`manifests`/… set
   * (appended lowest-priority). For an org whose manifests live under a house-named root the
   * defaults don't cover (e.g. `platform/`, `release/`).
   */
  manifestDirs?: string[]
  /**
   * House-layout path TEMPLATES that map a service DIRECTLY to its manifests, tried BEFORE the
   * heuristic search — the deterministic escape hatch for a layout the heuristics can't infer (or
   * that you simply want pinned). Each template may contain two placeholders:
   *
   * - `{service}` — the service directory's basename (e.g. `backend-acme` for a service whose
   *   `directory` is `services/team-alpha/backend-acme`).
   * - `{env}` — expanded across the known ephemeral-environment names (`prenv`, `preview`, `pr`,
   *   `dev`, `staging`, …); the first template whose expansion resolves to real manifests wins.
   *
   * E.g. `["deployment/k8s/overlays/{env}/{service}", "deployment/k8s/base/services/{service}"]`.
   * A template that resolves is used verbatim (highest confidence); if none resolve the heuristic
   * search runs as normal, so a template can only ADD determinism, never suppress detection.
   */
  serviceManifestPaths?: string[]
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
  /** Deployment-level extensions to the built-in file-name/directory conventions (additive). */
  conventions?: DetectionConventions
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
  // A bare `dev.yml` base (the acme-monolith `docker/dev.yml` shape) — lowest priority so a
  // canonical name still wins, but recognized so a complex multi-file compose repo is detected
  // (its OS overrides `dev.<os>.override.yml` become recipe compose-file candidates).
  'dev.yaml',
  'dev.yml',
]
// Bare `dev.ya?ml` is an AMBIGUOUS name — Ansible playbooks, tool/CLI config, and CI files all use
// it — so unlike the canonical `compose.*`/`docker-compose.*` names it is only accepted as a compose
// file when it actually declares a `services:` map (an empty/absent one ⇒ it isn't a compose file).
const AMBIGUOUS_COMPOSE_FILES = new Set(['dev.yaml', 'dev.yml'])
// The built-in (canonical) compose names, as a Set for a cheap membership test. A convention-added
// EXTRA name (not in here) is non-canonical, so — like the bare `dev.*` names — it is trusted as a
// compose file only when it actually declares `services:` (see `findCompose`).
const COMPOSE_FILE_SET = new Set(COMPOSE_FILES)
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
// Bounds the total reads so a pathological repo can't fan out unboundedly. Raised from 80 because
// the candidate lists grew (more k8s dirs, compose dirs, shared-deploy roots) and manifest-root
// collection no longer short-circuits on the first hit — still tiny versus a real API. Reads are
// intentionally SEQUENTIAL (not batched/parallel): the budget short-circuit and the "first present
// name/dir wins" ordering both depend on deterministic, in-order accounting. In practice a real
// repo resolves in a handful of reads well before the cap; the cap only bites on decoy-heavy repos,
// where truncation is surfaced as a note (see `BudgetedRepoScanner.exhausted`).
const READ_BUDGET = 200
const MAX_IMAGES = 8

// ---- Slice 2: stack-recipe detection (compose repos) -----------------------------------------
// All of the below feed a `docker-compose` recommendation's `recipe` + the recipe candidate arrays
// (compose-file layering / profiles / seed dumps) + the report-only repo-CLI hint. Detection stays
// deterministic + checkout-free; nothing is auto-applied beyond the pre-selected base layers.

// Template-file suffixes that materialize into a gitignored target (`.env.dev.local-dist` →
// `.env.dev.local`, `.split.yaml.dist` → `.split.yaml`, `.env.example` → `.env`). Longest/most
// specific first so a file is stripped by exactly one suffix. `strong` marks the config-template
// conventions (`-dist`/`.dist`, near-exclusively used for env/config) that accept any config-like
// target; the general `.example`/`.sample`/… suffixes accept only env-like targets so a non-env
// `values.yaml.example` (a Helm values sample) isn't scheduled to materialize `values.yaml`.
const ENV_TEMPLATE_SUFFIXES: { suffix: string; strong: boolean }[] = [
  { suffix: '-dist', strong: true },
  { suffix: '.dist', strong: true },
  { suffix: '.example', strong: false },
  { suffix: '.sample', strong: false },
  { suffix: '.template', strong: false },
  { suffix: '.tmpl', strong: false },
]
// Directories (relative to the service root) an env-template commonly sits in, beside the compose
// file's own dir. One `listDir` each; bounded by the read budget.
const ENV_TEMPLATE_DIR_CANDIDATES = ['', 'config', 'env', 'docker', '.docker']
// Cap on materialization pairs surfaced, so a decoy-heavy repo can't produce an unbounded recipe.
const MAX_ENV_FILES = 20
// Directories (relative to the service root) a SQL seed dump commonly lives under; each is scanned
// at its own level AND one level into immediate child dirs (acme's
// `deployment/acme-db-dummy/*.sql` shape).
const SEED_DIRS = [
  'deployment',
  'seed',
  'seeds',
  'db',
  'database',
  'sql',
  'docker-entrypoint-initdb.d',
  'fixtures',
  'dumps',
]
// Cap on seed-dump candidates surfaced.
const MAX_SEED_DUMPS = 12
// A `<stem>.<os>[.override].ya?ml` OS-specific compose override (`dev.wsl.override.yml`,
// `compose.mac.yml`). The OS token is normalized to the candidate schema's `os` picklist.
const OS_OVERRIDE_RE = /^(.+?)\.(wsl|mac|macos|osx|linux|windows|win)(?:\.override)?\.ya?ml$/i
// Report-only repo-CLI hint (imperative bring-up the deterministic scan can't read — a nudge toward
// the slice-8 analyst). Detection NEVER parses these files; it only flags their presence.
const MAKEFILE_NAMES = ['Makefile', 'makefile', 'GNUmakefile']
const JUSTFILE_NAMES = ['justfile', 'Justfile', '.justfile']
const TASKFILE_NAMES = ['Taskfile.yml', 'Taskfile.yaml', 'taskfile.yml', 'taskfile.yaml']
// Monorepo "service container" dirs an env/config template commonly lives ONE LEVEL DOWN in
// (`services/app/.env.dev.local-dist`, `apps/web/.env.example`). Scanned a single level deep by
// `collectEnvFileTemplates` in addition to the root-level dirs, so a per-service template outside
// the compose dir is still surfaced (the pilot's documented `services/app/` gap).
const ENV_TEMPLATE_CONTAINER_DIRS = ['services', 'apps', 'packages']

/** Append `extras` after `base`, dropping any already present in `base` (base wins / stays first). */
function withExtras(base: readonly string[], extras: string[] | undefined): string[] {
  if (!extras || extras.length === 0) return [...base]
  const seen = new Set(base)
  const out = [...base]
  for (const raw of extras) {
    const value = raw.trim()
    if (value && !seen.has(value)) {
      seen.add(value)
      out.push(value)
    }
  }
  return out
}

/**
 * The compose file names to try, canonical-first: the built-in {@link COMPOSE_FILES} then any
 * deployment-supplied extras (lowest priority, so a canonical name still wins). The
 * {@link AMBIGUOUS_COMPOSE_FILES} `services:`-required guard still applies to the bare `dev.*` names.
 */
function resolveComposeFileNames(conventions?: DetectionConventions): string[] {
  return withExtras(COMPOSE_FILES, conventions?.composeFiles)
}
function resolveComposeDirs(conventions?: DetectionConventions): string[] {
  return withExtras(COMPOSE_DIR_CANDIDATES, conventions?.composeDirs)
}
function resolveSeedDirs(conventions?: DetectionConventions): string[] {
  return withExtras(SEED_DIRS, conventions?.seedDirs)
}
function resolveEnvTemplateDirs(conventions?: DetectionConventions): string[] {
  return withExtras(ENV_TEMPLATE_DIR_CANDIDATES, conventions?.envTemplateDirs)
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
function parseManifestDocs(content: string): Record<string, unknown>[] {
  return parseDocs(content).filter(isKubernetesManifestDoc)
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
async function scanRawDir(
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
async function walkKustomize(
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

interface ComposeHit {
  /** Repo-relative compose file path (the value `composePath` would take). */
  path: string
  /** The directory the compose file was found in (repo-relative; `''` = the service/repo root). */
  dir: string
  /** The matched file name (e.g. `dev.yml`), used to derive the compose stem for the override family. */
  baseName: string
  /** The directory listing where the base was found — reused to collect the compose override family. */
  entries: { name: string; type: string; path: string }[]
  /** The declared `services:` keys (empty when unparseable / none). */
  services: string[]
  /** True when any service declares a `build:` — the stack builds its images from source. */
  hasBuild: boolean
  /** External networks the project expects to already exist (`external: true`) — resolved names. */
  externalNetworks: string[]
  /** `COMPOSE_PROFILES` labels declared across the file's services (deduped + sorted). */
  profiles: string[]
}

/**
 * Locate a Docker Compose file for the service, checking the service root AND the dirs it commonly
 * nests under (`deploy/`, `docker/`, …). One `listDir` per candidate dir; the canonical file name
 * wins (COMPOSE_FILES is canonical-first). Also parses the `services:` keys (for the service
 * picker), external networks + profiles (for the recipe), and the containing dir's listing (for the
 * `-f` override family).
 */
async function findCompose(
  scanner: BudgetedRepoScanner,
  root: string,
  conventions?: DetectionConventions,
): Promise<ComposeHit | null> {
  const composeFileNames = resolveComposeFileNames(conventions)
  for (const dir of resolveComposeDirs(conventions)) {
    const dirPath = joinRepoPath(root, dir)
    const entries = await scanner.listDir(dirPath)
    if (entries.length === 0) continue
    const names = new Set(entries.filter((e) => e.type !== 'dir').map((e) => e.name))
    for (const candidate of composeFileNames) {
      if (!names.has(candidate)) continue
      const path = joinRepoPath(dirPath, candidate)
      const content = await scanner.getFile(path)
      const doc = content ? parseOne(content) : null
      const servicesRecord = asRecord(doc?.services) ?? {}
      const services = Object.keys(servicesRecord)
      // An ambiguous bare `dev.ya?ml` — or ANY convention-added extra name, which is non-canonical
      // by definition — is only a compose file when it declares services; otherwise it's some other
      // YAML (CLI/CI/Ansible/app config) that merely matches the name and must not be detected as
      // compose. Canonical `compose.*`/`docker-compose.*` names are trusted without this guard.
      const requiresServices =
        AMBIGUOUS_COMPOSE_FILES.has(candidate) || !COMPOSE_FILE_SET.has(candidate)
      if (requiresServices && services.length === 0) continue
      // Single source of truth with the provider's build-mode rejection: any service with a
      // `build:` means the stack builds from source, so build mode is required to provision it.
      const hasBuild = Object.values(servicesRecord).some((s) => hasBuildDirective(s))
      return {
        path,
        dir: dirPath,
        baseName: candidate,
        entries,
        services,
        hasBuild,
        externalNetworks: doc ? extractExternalNetworks(doc) : [],
        profiles: doc ? extractComposeProfiles(doc) : [],
      }
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

/** The compose "stem" of a file name — the name with its `.yaml`/`.yml` extension stripped. */
function composeStem(baseName: string): string {
  return baseName.replace(/\.ya?ml$/i, '')
}

/** Normalize an OS token from an override file name onto the candidate schema's `os` picklist. */
function normalizeOs(token: string): NonNullable<ProvisioningComposeFileCandidate['os']> {
  const t = token.toLowerCase()
  if (t === 'wsl') return 'wsl'
  if (t === 'mac' || t === 'macos' || t === 'osx') return 'mac'
  if (t === 'linux') return 'linux'
  return 'windows' // windows | win
}

/** The OS an override file targets when it belongs to `stem`'s family (`dev.wsl.override.yml`), else null. */
function overrideOsFor(
  name: string,
  stem: string,
): NonNullable<ProvisioningComposeFileCandidate['os']> | null {
  const m = OS_OVERRIDE_RE.exec(name)
  return m && m[1] === stem ? normalizeOs(m[2]!) : null
}

/** True when `name` is a NON-OS `<stem>.override.ya?ml` auto-merge override of the found base. */
function isBaseOverride(name: string, stem: string): boolean {
  const m = /^(.+?)\.override\.ya?ml$/i.exec(name)
  return m !== null && m[1] === stem
}

/**
 * Assemble the compose-file layering from the base file's own directory listing. The primary base +
 * any `<stem>.override.ya?ml` auto-merge sibling become ordered base layers (pre-selected into
 * `recipe.composeFiles`); OS-specific overrides (`dev.<os>.override.yml`) are surfaced as opt-in
 * candidates annotated with `os` and NOT auto-layered. A lone base file with no family ⇒ `{}` (the
 * simple `composePath` suffices — no recipe layering needed).
 */
function collectComposeFiles(compose: ComposeHit): {
  composeFiles?: string[]
  composeFileCandidates?: ProvisioningComposeFileCandidate[]
} {
  const stem = composeStem(compose.baseName)
  const baseFiles: string[] = [compose.path]
  const baseOverrideNames: string[] = []
  const osOverrides: {
    path: string
    name: string
    os: NonNullable<ProvisioningComposeFileCandidate['os']>
  }[] = []
  for (const entry of compose.entries) {
    if (entry.type === 'dir' || entry.name === compose.baseName) continue
    const os = overrideOsFor(entry.name, stem)
    if (os) osOverrides.push({ path: joinRepoPath(compose.dir, entry.name), name: entry.name, os })
    else if (isBaseOverride(entry.name, stem)) baseOverrideNames.push(entry.name)
  }
  // No override family beyond the single base file ⇒ nothing to layer.
  if (osOverrides.length === 0 && baseOverrideNames.length === 0) return {}

  for (const name of baseOverrideNames.sort()) baseFiles.push(joinRepoPath(compose.dir, name))
  osOverrides.sort((a, b) => a.name.localeCompare(b.name))
  const composeFileCandidates: ProvisioningComposeFileCandidate[] = [
    ...baseFiles.map((path) => ({ path, name: path.split('/').pop() ?? path, recommended: true })),
    ...osOverrides.map((o) => ({ path: o.path, name: o.name, os: o.os, recommended: false })),
  ]
  return { composeFiles: baseFiles, composeFileCandidates }
}

/** Map a template file name to its materialization target (stripped suffix), or null when it isn't
 * a config/env template (`README.dist` → null; `.env.dev.local-dist` → `.env.dev.local`;
 * `values.yaml.example` → null — a Helm values sample, not env). A `strong` (`-dist`/`.dist`)
 * suffix accepts any config-like target; the general suffixes accept only an env-like target. */
function deriveEnvTemplateTarget(name: string): string | null {
  for (const { suffix, strong } of ENV_TEMPLATE_SUFFIXES) {
    if (name.length <= suffix.length || !name.endsWith(suffix)) continue
    const target = name.slice(0, -suffix.length)
    const accepted = strong ? isConfigLikeName(target) : isEnvLikeName(target)
    return accepted ? target : null
  }
  return null
}

/** True when a target is an env file per se — a dotfile or an `env`-bearing name (`.env`,
 * `.env.dev.local`, `environment.local`). The bar the general (non-`dist`) template suffixes clear. */
function isEnvLikeName(target: string): boolean {
  return target.startsWith('.') || target.toLowerCase().includes('env')
}

/** True when a template's stripped target looks like an env/config file (so we don't materialize a
 * `README.dist` or a `.tar.dist`). A dotfile, an `env`-bearing name, or a config extension. */
function isConfigLikeName(target: string): boolean {
  const lower = target.toLowerCase()
  return (
    isEnvLikeName(target) || /\.(ya?ml|json|ini|conf|cfg|config|properties|toml|local)$/.test(lower)
  )
}

/**
 * Find committed env/config TEMPLATE files (`*-dist` / `*.example` / …) beside the compose file and
 * in the service root's common config dirs, and pair each with its gitignored target. Deduped by
 * target; bounded by `MAX_ENV_FILES`. These become `recipe.envFiles` — materialized before `up`.
 *
 * Scans, in order: the compose dir, the root-level config dirs (`ENV_TEMPLATE_DIR_CANDIDATES` +
 * any deployment `conventions.envTemplateDirs`), then ONE LEVEL DOWN into the monorepo
 * service-container dirs (`ENV_TEMPLATE_CONTAINER_DIRS` — `services/<svc>/`, `apps/<svc>/`), so a
 * per-service template that lives outside the compose dir (the pilot's `services/app/.env.dev.local-dist`
 * gap) is still surfaced. First template seen for a given target wins; the root-level dirs are scanned
 * before the deeper container dirs so a root/compose-dir template takes precedence.
 */
async function collectEnvFileTemplates(
  scanner: BudgetedRepoScanner,
  root: string,
  composeDir: string,
  conventions?: DetectionConventions,
): Promise<RecipeEnvFile[]> {
  const pairs: RecipeEnvFile[] = []
  const seenTargets = new Set<string>()
  const sorted = (): RecipeEnvFile[] => pairs.sort((a, b) => a.template.localeCompare(b.template))
  // Scan one flat directory; returns true once MAX_ENV_FILES is reached (caller stops).
  const scanDir = async (dir: string): Promise<boolean> => {
    // Sort by name so the dedup-by-target choice (first template seen wins) is deterministic
    // regardless of the reader's directory-listing order.
    const entries = [...(await scanner.listDir(dir))].sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (entry.type === 'dir') continue
      const target = deriveEnvTemplateTarget(entry.name)
      if (!target) continue
      const targetPath = joinRepoPath(dir, target)
      if (seenTargets.has(targetPath)) continue
      seenTargets.add(targetPath)
      pairs.push({ template: joinRepoPath(dir, entry.name), target: targetPath })
      if (pairs.length >= MAX_ENV_FILES) return true
    }
    return false
  }

  const rootDirs = [
    ...new Set([
      composeDir,
      ...resolveEnvTemplateDirs(conventions).map((d) => joinRepoPath(root, d)),
    ]),
  ]
  for (const dir of rootDirs) {
    if (await scanDir(dir)) return sorted()
  }
  // One level into monorepo service containers (`services/app/…`), children sorted for determinism.
  for (const container of ENV_TEMPLATE_CONTAINER_DIRS) {
    const containerDir = joinRepoPath(root, container)
    const children = [...(await scanner.listDir(containerDir))]
      .filter((e) => e.type === 'dir')
      .sort((a, b) => a.name.localeCompare(b.name))
    for (const child of children) {
      if (await scanDir(joinRepoPath(containerDir, child.name))) return sorted()
    }
  }
  return sorted()
}

// Whole-token matches (bounded by `^`/`$` or a non-letter — `-`, `_`, `.`, digits — so `pre` does
// NOT match inside `compressed` and `data` DOES match inside `add_data`) for the seed-dump ranking.
const SEED_DATA_TOKENS = /(^|[^a-z])(seed|dummy|data|dump|fixture|sample)([^a-z]|$)/
const SEED_SCHEMA_TOKENS = /(^|[^a-z])(pre|schema|structure|ddl|migration|create|drop)([^a-z]|$)/

/** Rank a SQL dump for the seed pre-selection: prefer full seed/dummy data, deprioritize
 * schema/pre/structure-only dumps. Higher wins; ties break deterministically by path. */
function rankSeedDump(name: string): number {
  const lower = name.toLowerCase()
  let score = 0
  if (SEED_DATA_TOKENS.test(lower)) score += 2
  if (SEED_SCHEMA_TOKENS.test(lower)) score -= 1
  return score
}

/**
 * Scan the seed-ish directories for `.sql` dumps (each dir + one level into its child dirs, the
 * `deployment/<db>/*.sql` shape) and surface them as low-confidence candidates — the wizard confirms
 * one into a `compose-exec` seed-import step (never auto-applied). The heuristically-fullest dump is
 * pre-selected.
 */
async function collectSeedDumps(
  scanner: BudgetedRepoScanner,
  root: string,
  conventions?: DetectionConventions,
): Promise<ProvisioningSeedDumpCandidate[]> {
  const found: { path: string; name: string }[] = []
  const seen = new Set<string>()
  const addSql = (dir: string, name: string): void => {
    if (!name.toLowerCase().endsWith('.sql')) return
    const path = joinRepoPath(dir, name)
    if (seen.has(path)) return
    seen.add(path)
    found.push({ path, name })
  }
  // Collect `.sql` dumps for one directory entry: a file is added directly; a dir is scanned
  // one level in. Extracted so the child-dir loop doesn't nest under the two outer loops
  // (keeps max-depth ≤ 4).
  const scanEntry = async (dir: string, entry: RepoScanEntry): Promise<void> => {
    if (entry.type !== 'dir') {
      addSql(dir, entry.name)
      return
    }
    // A `migrations`/`migration` child holds schema DDL, not seed data — never a seed dump.
    if (/^migrations?$/i.test(entry.name)) return
    const childDir = joinRepoPath(dir, entry.name)
    for (const child of await scanner.listDir(childDir)) {
      if (child.type !== 'dir') addSql(childDir, child.name)
      if (found.length >= MAX_SEED_DUMPS) break
    }
  }
  for (const rel of resolveSeedDirs(conventions)) {
    if (found.length >= MAX_SEED_DUMPS) break
    const dir = joinRepoPath(root, rel)
    const entries = await scanner.listDir(dir)
    for (const entry of entries) {
      if (found.length >= MAX_SEED_DUMPS) break
      await scanEntry(dir, entry)
    }
  }
  if (found.length === 0) return []
  // Sort by path so both the surfaced order and the pre-selection tie-break are deterministic
  // regardless of the reader's directory-listing order.
  found.sort((a, b) => a.path.localeCompare(b.path))
  let bestIdx = 0
  let bestScore = rankSeedDump(found[0]!.name)
  for (let i = 1; i < found.length; i++) {
    const score = rankSeedDump(found[i]!.name)
    if (score > bestScore) {
      bestScore = score
      bestIdx = i
    }
  }
  return found.map((f, i) => ({ path: f.path, name: f.name, recommended: i === bestIdx }))
}

/**
 * A REPORT-ONLY hint that the repo carries its own imperative bring-up — a `bin/*console*` repo CLI,
 * a Makefile, a justfile, or a Taskfile. Detection NEVER parses these files; it only flags the first
 * one found (repo-CLI first, then Makefile → justfile → Taskfile) so the wizard can nudge toward the
 * slice-8 analyst. `rootEntries` is the already-read root listing (no extra read for the top-level files).
 */
async function detectRepoCliHint(
  scanner: BudgetedRepoScanner,
  root: string,
  rootEntries: { name: string; type: string; path: string }[],
): Promise<ProvisioningRepoCliHint | undefined> {
  const fileNames = new Set(rootEntries.filter((e) => e.type !== 'dir').map((e) => e.name))
  const hasBin = rootEntries.some((e) => e.type === 'dir' && e.name === 'bin')
  if (hasBin) {
    for (const entry of await scanner.listDir(joinRepoPath(root, 'bin'))) {
      if (entry.type === 'dir') continue
      const lower = entry.name.toLowerCase()
      if (
        lower.includes('console') ||
        lower.includes('cli') ||
        lower === 'dev' ||
        lower === 'setup'
      ) {
        return { path: joinRepoPath(root, 'bin', entry.name), kind: 'repo-cli' }
      }
    }
  }
  for (const name of MAKEFILE_NAMES) {
    if (fileNames.has(name)) return { path: joinRepoPath(root, name), kind: 'makefile' }
  }
  for (const name of JUSTFILE_NAMES) {
    if (fileNames.has(name)) return { path: joinRepoPath(root, name), kind: 'justfile' }
  }
  for (const name of TASKFILE_NAMES) {
    if (fileNames.has(name)) return { path: joinRepoPath(root, name), kind: 'taskfile' }
  }
  return undefined
}

/**
 * Build the `docker-compose` recommendation. Beyond the base `composePath` + build-mode detection,
 * this reads the STACK RECIPE a complex compose repo implies (the acme-monolith pilot): multi-`-f`
 * layering, external networks, env-file materialization → `recipe`; profiles + seed dumps →
 * candidate arrays the wizard confirms; a repo-CLI hint → the analyst nudge. When NONE of those are
 * present the output is exactly the simple single-file recommendation (no `recipe`, no extra notes).
 */
async function buildComposeRecommendation(
  scanner: BudgetedRepoScanner,
  root: string,
  compose: ComposeHit,
  serviceBasename: string,
  kubernetesAlsoExists = false,
  conventions?: DetectionConventions,
): Promise<ProvisioningRecommendation> {
  const notes: ProvisioningDetectionNote[] = [
    {
      field: 'provisionType',
      confidence: 'high',
      message: `Detected a Docker Compose file at ${compose.path}.`,
    },
  ]
  // A service that declares `build:` can only run in build-from-source mode (the checkout-free
  // image-pull path would reject it), so recommend build mode — a Docker-daemon capability, so
  // only a local deployment can provision it.
  if (compose.hasBuild) {
    notes.push({
      field: 'composeBuild',
      confidence: 'high',
      message:
        'This compose stack builds its images from source (build:). Recommending build-from-source mode, which clones the PR head and runs `docker compose build` — available only on a local (Docker-capable) deployment.',
    })
  }
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

  // --- Stack recipe detection (populated only when the repo is actually recipe-shaped) ----------
  const recipe: StackRecipe = {}
  const rootEntries = await scanner.listDir(root)

  const { composeFiles, composeFileCandidates } = collectComposeFiles(compose)
  if (composeFiles) {
    recipe.composeFiles = composeFiles
    const osCount = composeFileCandidates!.filter((c) => c.os).length
    notes.push({
      field: 'composeFiles',
      confidence: 'high',
      message: `Layered ${composeFiles.length} compose file(s): ${composeFiles.join(' → ')}.${osCount > 0 ? ` ${osCount} OS-specific override(s) surfaced — pick the one matching your machine.` : ''}`,
    })
  }

  if (compose.externalNetworks.length > 0) {
    recipe.externalNetworks = compose.externalNetworks
    notes.push({
      field: 'externalNetworks',
      confidence: 'high',
      message: `This project expects external network(s) to already exist: ${compose.externalNetworks.join(', ')}. They must be created before it comes up.`,
    })
    notes.push({
      field: 'sharedStackRefs',
      confidence: 'low',
      message: `Bind the external network(s) (${compose.externalNetworks.join(', ')}) to a shared stack so it is brought up first, or create them on the host manually.`,
    })
  }

  const envFiles = await collectEnvFileTemplates(scanner, root, compose.dir, conventions)
  if (envFiles.length > 0) {
    recipe.envFiles = envFiles
    notes.push({
      field: 'envFiles',
      confidence: 'low',
      message: `Found ${envFiles.length} env/config template(s) to materialize before up: ${envFiles.map((e) => `${e.template} → ${e.target}`).join(', ')}. Confirm each pair.`,
    })
  }

  const profileCandidates: ProvisioningProfileCandidate[] | undefined =
    compose.profiles.length > 0
      ? compose.profiles.map((profile) => ({ profile, recommended: false }))
      : undefined
  if (profileCandidates) {
    notes.push({
      field: 'composeProfiles',
      confidence: 'low',
      message: `The compose file declares ${profileCandidates.length} profile(s): ${compose.profiles.join(', ')}. All surfaced default-off — enable the optional service groups you need.`,
    })
  }

  const seedDumpCandidates = await collectSeedDumps(scanner, root, conventions)
  if (seedDumpCandidates.length > 0) {
    const pick = seedDumpCandidates.find((s) => s.recommended)
    notes.push({
      field: 'seedDump',
      confidence: 'low',
      message: `Found ${seedDumpCandidates.length} SQL seed dump(s)${pick ? ` (pre-selected ${pick.path})` : ''}. Confirm one to import as a seed step; none is applied automatically.`,
    })
  }

  const repoCliHint = await detectRepoCliHint(scanner, root, rootEntries)
  if (repoCliHint) {
    notes.push({
      field: 'repoCli',
      confidence: 'low',
      message: `This repo has its own imperative bring-up (${repoCliHint.kind} at ${repoCliHint.path}); the deterministic scan can't read it. Consider running deep analysis to translate its setup into recipe steps.`,
    })
  }

  const provisioning: ServiceProvisioning = {
    type: 'docker-compose',
    composePath: compose.path,
    ...(compose.hasBuild ? { composeBuild: true } : {}),
    ...(Object.keys(recipe).length > 0 ? { recipe } : {}),
  }

  return {
    detected: true,
    provisioning,
    ...(composeServiceCandidates ? { composeServiceCandidates } : {}),
    ...(composeFileCandidates ? { composeFileCandidates } : {}),
    ...(profileCandidates ? { profileCandidates } : {}),
    ...(seedDumpCandidates.length > 0 ? { seedDumpCandidates } : {}),
    ...(repoCliHint ? { repoCliHint } : {}),
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
  scanner: BudgetedRepoScanner,
  roots: KubernetesRoot[],
  lookupRoot: string,
  opts: KubernetesBuildOptions,
): Promise<ProvisioningRecommendation> {
  const notes: ProvisioningDetectionNote[] = []
  let effectiveRoots = roots
  let chosen = effectiveRoots[0]!

  // A Kustomize Component isn't independently deployable (`kustomize build` rejects it). If the chosen
  // slice is one, prefer the overlay that aggregates it (its `components:` parent) so the recommended
  // source actually renders; when no aggregator references it, keep the component but warn clearly.
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
  if (effectiveRoots.length > 1) {
    manifestRootCandidates = effectiveRoots.map((r, i) => ({
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
  const root = joinRepoPath(options.directory ?? '')
  const scanner = new BudgetedRepoScanner(reader, READ_BUDGET, options.gitRef)
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
  const exact = joinRepoPath(root, defaultPath)
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
      const nested = joinRepoPath(entry.path, defaultPath)
      if ((await scanner.getFile(nested)) !== null) {
        return rec(true, nested, {
          field: 'manifestPath',
          confidence: 'high',
          message: `Found ${defaultPath} one level deep at ${nested}.`,
        })
      }
    }
  }

  // 2c. Not found anywhere. If the lookups couldn't actually READ the repo (a genuine fault, not a
  // clean miss), surface that instead of a misleading "not found — will be created".
  if (scanner.readFault) throw new RepoReadError(scanner.readFault)
  // Keep a path the user deliberately entered (they may be pointing at a file to be generated);
  // only fall back to the default location when there's no current value — never silently
  // overwrite an explicit entry. Either way "generate" writes to the kept path.
  const target = currentPath || exact
  return rec(false, target, {
    field: 'manifestPath',
    confidence: 'low',
    message: currentPath
      ? `No custom manifest found; kept the entered path ${target}. It will be created when you generate the manifest.`
      : `No custom manifest found; pre-filled the default location ${target}. It will be created when you generate the manifest.`,
  })
}
