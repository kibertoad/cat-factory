import type {
  ProvisioningComposeFileCandidate,
  ProvisioningComposeServiceCandidate,
  ProvisioningDetectionNote,
  ProvisioningProfileCandidate,
  ProvisioningRecommendation,
  ProvisioningRepoCliHint,
  ProvisioningSeedDumpCandidate,
  RecipeEnvFile,
  ServiceProvisioning,
  StackRecipe,
} from '@cat-factory/contracts'
import type { RepoScanEntry } from '@cat-factory/kernel'
import { BudgetedRepoScanner, joinRepoPath } from '@cat-factory/kernel'
import {
  extractComposeProfiles,
  extractExternalNetworks,
  hasBuildDirective,
} from '../compose/compose-environment.logic.js'
import { asRecord, parseOne } from './provision-detect.yaml.js'
import { type DetectionConventions, withExtras } from './provision-detect.contract.js'

// The DOCKER-COMPOSE half of provisioning auto-detection: locating a compose file, and the
// STACK RECIPE a complex compose repo implies (the `-f` override family, external networks,
// env/config templates to materialize, profiles, SQL seed dumps, and the report-only repo-CLI
// hint), assembled into a `docker-compose` recommendation.
//
// Split out of `provision-detect.logic.ts`, which keeps the Kubernetes half and the two entry
// points and imports this module, so neither file carries the other's heuristics. Same seam
// `provision-detect.kubernetes.ts` was extracted along. Detection stays deterministic and
// checkout-free; nothing here is auto-applied beyond the pre-selected base layers.

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

export interface ComposeHit {
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
export async function findCompose(
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
export function collectComposeFiles(compose: ComposeHit): {
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
export async function collectEnvFileTemplates(
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
export async function buildComposeRecommendation(
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
