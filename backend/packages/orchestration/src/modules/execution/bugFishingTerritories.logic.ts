import type {
  BlueprintService,
  BugFishingPhase,
  BugFishingTerritory,
  BugFishingUnfishedCell,
  RepoContentEntry,
  RepoTreeListing,
} from '@cat-factory/kernel'
import { WHOLE_CODEBASE_TERRITORY_ID } from '@cat-factory/kernel'

// ---------------------------------------------------------------------------
// Partitioning a codebase into TERRITORIES, and planning the (territory x angle) matrix an
// expedition fishes over them.
//
// Everything here is a pure function of (tree, options) -> plan, so the rule that decides what a
// large expedition covers is unit-testable without a repository, a run, or a model. The design
// record is docs/initiatives/bug-fishing-expedition.md ("Large codebases"); the one sentence that
// governs the whole module is its rule: the platform COMPUTES the partition, the model JUDGES the
// code. Nothing below asks an LLM where the modules are.
// ---------------------------------------------------------------------------

/**
 * Target source tokens per territory: roughly what one pass can read a meaningful share of with
 * ranged reads. Bytes / 4 over the tree's blob sizes, so it is an estimate by construction, which
 * is why the persisted field is named `approxTokens`.
 */
const TARGET_TERRITORY_TOKENS = 150_000
/** No territory may exceed twice the target; one that would is split along its sub-directories. */
const MAX_TERRITORY_TOKENS = TARGET_TERRITORY_TOKENS * 2
/** Bytes per token, the estimator every sizing decision here uses. */
const BYTES_PER_TOKEN = 4
/**
 * What a file with no reported size is assumed to weigh.
 *
 * GitHub's tree read carries a blob size per file; GitLab's does not. Rather than sizing a GitLab
 * repository as weightless (which would pack the whole codebase into one territory and silently
 * undo the partition), a size-less entry counts as a middling source file. The estimate is stated
 * here in one place so the failure mode is "territories are sized coarsely" rather than "sizing
 * silently stopped applying on one provider".
 */
const ASSUMED_FILE_BYTES = 4_000

/**
 * Paths never worth fishing: generated output, vendored trees, dependency directories, lockfiles
 * and fixtures. The finding bar cannot be applied to code nobody in this repository wrote, and a
 * territory packed with `dist/` is budget spent on nothing.
 *
 * The vocabulary the file-size ratchet skips (`scripts/check-file-size.mjs`'s `SKIP_DIRS`) plus
 * the generated/vendored shapes that ratchet never has to see, because it scans a checkout and
 * this reads a provider's whole tree.
 */
const IGNORED_DIR_SEGMENTS = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'vendor',
  'vendored',
  'third_party',
  'coverage',
  '.git',
  '.turbo',
  '.nuxt',
  '.output',
  '.next',
  '.venv',
  '.stryker-tmp',
  '__snapshots__',
  '__pycache__',
])

/** File names that are generated or otherwise not source anybody reads for defects. */
const IGNORED_FILE_NAMES = new Set([
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'bun.lockb',
  'poetry.lock',
  'Cargo.lock',
  'go.sum',
  'composer.lock',
  'Gemfile.lock',
])

/** A file name suffix that marks generated output regardless of where it sits. */
const IGNORED_FILE_SUFFIXES = ['.generated.ts', '.generated.js', '.min.js', '.snap', '.map']

/**
 * A file that marks the directory it sits in as a PACKAGE boundary. A territory stops here rather
 * than packing across it, because a package is a unit somebody already decided was cohesive, and
 * "has something else already handled it?" is answered inside one far more often than across two.
 */
const PACKAGE_MARKERS = new Set([
  'package.json',
  'pyproject.toml',
  'setup.py',
  'go.mod',
  'Cargo.toml',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'composer.json',
  'Gemfile',
])

/** Whether a candidate's own root directory carries a package marker. */
function isPackageRoot(candidate: Candidate): boolean {
  const root = candidate.roots[0]
  if (candidate.roots.length !== 1 || root === undefined) return false
  const prefix = root ? `${root}/` : ''
  return candidate.files.some(
    (file) => file.path.startsWith(prefix) && PACKAGE_MARKERS.has(file.path.slice(prefix.length)),
  )
}

/** Whether a repo-relative path is source the expedition should fish. */
export function isFishablePath(path: string): boolean {
  if (!path) return false
  const segments = path.split('/')
  const name = segments[segments.length - 1] ?? ''
  if (segments.some((segment) => IGNORED_DIR_SEGMENTS.has(segment))) return false
  if (IGNORED_FILE_NAMES.has(name)) return false
  return !IGNORED_FILE_SUFFIXES.some((suffix) => name.endsWith(suffix))
}

/** One file of the survey's manifest: the path, and what it weighs. */
export interface SurveyedFile {
  path: string
  bytes: number
}

/** What a survey of the repository tree produced. */
export interface CodebaseSurvey {
  /** The partition, in the order the expedition fishes it. Always at least one entry. */
  territories: BugFishingTerritory[]
  /** Every fishable file under the survey root, indexed by territory id. */
  filesByTerritory: Map<string, SurveyedFile[]>
  /** True when the provider cut the tree short: the manifest is a prefix of the codebase. */
  treeTruncated: boolean
}

/** Options a survey takes beyond the tree itself. */
export interface SurveyOptions {
  /**
   * The monorepo subdirectory the service lives in, when it has one. The survey walks from here
   * rather than from the repository root: a sibling service's code is out of scope for an
   * expedition exactly as it is for every other run.
   */
  serviceDirectory?: string | null
  /**
   * The service's committed blueprint, when the repository has one. Its modules are the
   * platform's own decomposition and win over the directory heuristic; a module whose references
   * the tree no longer has falls through to the directory rule rather than being guessed onto a
   * new home.
   */
  blueprint?: BlueprintService | null
}

/** Normalise a repo-relative path: no leading or trailing slash, no `./`. */
function normalizePath(path: string): string {
  return path.replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '')
}

/**
 * The fishable FILES of a tree, scoped to the survey root and sized.
 *
 * Directories are dropped here rather than filtered at each later step: a territory is a set of
 * files, and a `dir` entry carries no bytes to size it with. The subtree shas the territories
 * record come from the directory entries, read separately below.
 */
function fishableFiles(entries: readonly RepoContentEntry[], root: string): SurveyedFile[] {
  const prefix = root ? `${root}/` : ''
  const files: SurveyedFile[] = []
  for (const entry of entries) {
    if (entry.type !== 'file') continue
    const path = normalizePath(entry.path)
    if (prefix && !path.startsWith(prefix)) continue
    if (!isFishablePath(path)) continue
    files.push({ path, bytes: typeof entry.size === 'number' ? entry.size : ASSUMED_FILE_BYTES })
  }
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

/** Subtree shas of the tree's directory entries, keyed by normalised path. */
function subtreeShas(entries: readonly RepoContentEntry[]): Map<string, string> {
  const shas = new Map<string, string>()
  for (const entry of entries) {
    if (entry.type === 'dir' && entry.sha) shas.set(normalizePath(entry.path), entry.sha)
  }
  return shas
}

function tokensOf(files: readonly SurveyedFile[]): number {
  return Math.round(files.reduce((sum, file) => sum + file.bytes, 0) / BYTES_PER_TOKEN)
}

/** A territory id derived from its roots: stable for the same partition of the same tree. */
function territoryIdFor(roots: readonly string[]): string {
  const first = roots[0] ?? WHOLE_CODEBASE_TERRITORY_ID
  const slug = first.replace(/[^a-zA-Z0-9._/-]/g, '-').replace(/\//g, '.')
  return roots.length > 1 ? `${slug}+${roots.length - 1}` : slug
}

/** The label a human reads for a territory rooted at `root`. */
function labelFor(root: string, serviceRoot: string): string {
  const relative =
    serviceRoot && root.startsWith(`${serviceRoot}/`) ? root.slice(serviceRoot.length + 1) : root
  return relative || 'Whole codebase'
}

/**
 * The single territory a codebase small enough to fish whole gets.
 *
 * The PASS-THROUGH: its phases carry no territory id, so the expedition is byte-for-byte the one
 * that shipped before territories existed. Large-codebase mode is a size threshold crossed, never
 * a mode a task opts into.
 */
function wholeCodebaseTerritory(files: readonly SurveyedFile[]): BugFishingTerritory {
  return {
    id: WHOLE_CODEBASE_TERRITORY_ID,
    label: 'Whole codebase',
    roots: [],
    fileCount: files.length,
    approxTokens: tokensOf(files),
    source: 'whole-codebase',
    subtreeShas: [],
  }
}

/**
 * Group a set of files by their first path segment BELOW `root`, so a directory stays whole
 * whenever it fits. Files sitting directly in `root` are grouped under `root` itself.
 */
function groupByChildDirectory(
  files: readonly SurveyedFile[],
  root: string,
): Map<string, SurveyedFile[]> {
  const groups = new Map<string, SurveyedFile[]>()
  const prefixLength = root ? root.length + 1 : 0
  for (const file of files) {
    const rest = file.path.slice(prefixLength)
    const slash = rest.indexOf('/')
    const key =
      slash === -1 ? root : root ? `${root}/${rest.slice(0, slash)}` : rest.slice(0, slash)
    const bucket = groups.get(key)
    if (bucket) bucket.push(file)
    else groups.set(key, [file])
  }
  return groups
}

/** A candidate territory before it is stamped with an id and a label. */
interface Candidate {
  roots: string[]
  files: SurveyedFile[]
  source: 'blueprint' | 'directory'
}

/**
 * Split a candidate that is over the hard ceiling along its own sub-directories, recursively.
 *
 * A group that cannot be split further (one directory whose own files exceed the ceiling) is
 * KEPT oversized rather than chopped at an arbitrary file boundary: a territory is meant to be a
 * unit somebody could reason about, and half of one is worse for the finding bar than a big one.
 */
function splitOversized(candidate: Candidate): Candidate[] {
  if (tokensOf(candidate.files) <= MAX_TERRITORY_TOKENS) return [candidate]
  const root = candidate.roots[0]
  if (candidate.roots.length !== 1 || root === undefined) {
    // A packed multi-root candidate is over the ceiling only if packing was wrong; unpack it.
    return candidate.roots.map((r) => ({
      roots: [r],
      files: candidate.files.filter((f) => f.path === r || f.path.startsWith(`${r}/`)),
      source: candidate.source,
    }))
  }
  const groups = groupByChildDirectory(candidate.files, root)
  if (groups.size <= 1) return [candidate]
  return [...groups.entries()].flatMap(([childRoot, files]) =>
    splitOversized({ roots: [childRoot], files, source: candidate.source }),
  )
}

/**
 * Pack small candidates together up to the target size, keeping catalog order.
 *
 * Sibling directories of a few hundred lines each are not worth their own dispatch: eight angles
 * over a five-file territory spends the pass budget on orientation. Packing is ordered rather
 * than best-fit so two surveys of the same tree produce the same partition.
 */
function packSmall(candidates: readonly Candidate[]): Candidate[] {
  const packed: Candidate[] = []
  for (const candidate of candidates) {
    const previous = packed[packed.length - 1]
    if (
      previous &&
      previous.source === candidate.source &&
      !isPackageRoot(candidate) &&
      !isPackageRoot(previous) &&
      tokensOf(previous.files) + tokensOf(candidate.files) <= TARGET_TERRITORY_TOKENS
    ) {
      previous.roots.push(...candidate.roots)
      previous.files.push(...candidate.files)
      continue
    }
    packed.push({
      roots: [...candidate.roots],
      files: [...candidate.files],
      source: candidate.source,
    })
  }
  return packed
}

/**
 * The blueprint's own decomposition as candidates, plus whatever it does not cover.
 *
 * A blueprint's `references` were written by a model against an older tree, so a reference the
 * tree no longer has is DROPPED and its module falls through to the directory rule for its part
 * of the tree, never guessed onto a new home. Anything no module claims is partitioned by the
 * directory rule too, so a partial blueprint narrows the heuristic rather than replacing it.
 */
function blueprintCandidates(
  files: readonly SurveyedFile[],
  blueprint: BlueprintService,
  serviceRoot: string,
): { candidates: Candidate[]; unclaimed: SurveyedFile[] } {
  const claimed = new Set<string>()
  const candidates: Candidate[] = []
  for (const module of blueprint.modules ?? []) {
    const roots = (module.references ?? [])
      .map((reference) => normalizePath(reference))
      .map((reference) =>
        serviceRoot && !reference.startsWith(`${serviceRoot}/`) && reference !== serviceRoot
          ? `${serviceRoot}/${reference}`
          : reference,
      )
      .filter((reference) => reference.length > 0)
    const moduleFiles = files.filter(
      (file) =>
        !claimed.has(file.path) &&
        roots.some((root) => file.path === root || file.path.startsWith(`${root}/`)),
    )
    if (moduleFiles.length === 0) continue
    for (const file of moduleFiles) claimed.add(file.path)
    candidates.push({ roots, files: moduleFiles, source: 'blueprint' })
  }
  return { candidates, unclaimed: files.filter((file) => !claimed.has(file.path)) }
}

/**
 * Partition a repository tree into the territories an expedition fishes.
 *
 * Blueprint modules first when the repository has a blueprint, then package and directory
 * boundaries under the survey root, sized by the tree's blob bytes. A codebase that fits one
 * territory yields exactly one, and the expedition it plans is today's.
 */
export function partitionCodebase(
  tree: RepoTreeListing,
  options: SurveyOptions = {},
): CodebaseSurvey {
  const serviceRoot = normalizePath(options.serviceDirectory ?? '')
  const files = fishableFiles(tree.entries, serviceRoot)
  const shas = subtreeShas(tree.entries)
  const filesByTerritory = new Map<string, SurveyedFile[]>()

  if (tokensOf(files) <= MAX_TERRITORY_TOKENS) {
    const only = wholeCodebaseTerritory(files)
    filesByTerritory.set(only.id, files)
    return { territories: [only], filesByTerritory, treeTruncated: tree.truncated }
  }

  const blueprint = options.blueprint
    ? blueprintCandidates(files, options.blueprint, serviceRoot)
    : { candidates: [] as Candidate[], unclaimed: files }
  const byDirectory = [...groupByChildDirectory(blueprint.unclaimed, serviceRoot).entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([root, group]): Candidate => ({ roots: [root], files: group, source: 'directory' }))

  const candidates = packSmall(
    [...blueprint.candidates, ...byDirectory].flatMap((candidate) => splitOversized(candidate)),
  )
  const territories = candidates.map((candidate): BugFishingTerritory => {
    const id = territoryIdFor(candidate.roots)
    filesByTerritory.set(id, candidate.files)
    return {
      id,
      label: candidate.roots.map((root) => labelFor(root, serviceRoot)).join(', '),
      roots: candidate.roots,
      fileCount: candidate.files.length,
      approxTokens: tokensOf(candidate.files),
      source: candidate.source,
      subtreeShas: candidate.roots.map((root) => shas.get(root) ?? ''),
    }
  })
  return { territories, filesByTerritory, treeTruncated: tree.truncated }
}

// ---- Planning the matrix ---------------------------------------------------

/** One planned cell: an angle fished over a territory. */
export interface PlannedCell {
  territory: BugFishingTerritory
  phase: BugFishingPhase
}

/**
 * Build the pass list from the territories and the angles, TERRITORY-MAJOR, trimmed to the pass
 * budget.
 *
 * Territory-major so a human gets a complete answer for one territory early and can start its
 * fixes while the rest is still being fished, which is what the separate-dispatch design is for.
 * The budget trims from the BOTTOM of the order rather than the middle, and what it cuts is
 * returned as unfished: a cap silent about its tail teaches the reader that the tail was clean.
 *
 * A single whole-codebase territory yields the angles unchanged, with no territory stamped on
 * them, so a small codebase's plan is field-for-field the one that shipped before territories.
 */
export function planTerritoryPasses(input: {
  territories: readonly BugFishingTerritory[]
  angles: readonly BugFishingPhase[]
  passBudget: number
}): { phases: BugFishingPhase[]; unfished: BugFishingUnfishedCell[]; plannedCells: number } {
  const { territories, angles, passBudget } = input
  const whole =
    territories.length <= 1 &&
    (territories[0]?.source === 'whole-codebase' || territories.length === 0)
  const cells: PlannedCell[] = territories.flatMap((territory) =>
    angles.map((phase) => ({ territory, phase })),
  )
  const plannedCells = whole ? angles.length : cells.length
  if (whole) {
    return {
      phases: angles.slice(0, passBudget),
      unfished: unfishedFor(cells.slice(passBudget)),
      plannedCells,
    }
  }
  const kept = cells.slice(0, passBudget)
  return {
    phases: kept.map(({ territory, phase }) => ({
      ...phase,
      territoryId: territory.id,
      territoryLabel: territory.label,
    })),
    unfished: unfishedFor(cells.slice(passBudget)),
    plannedCells,
  }
}

function unfishedFor(cells: readonly PlannedCell[]): BugFishingUnfishedCell[] {
  return cells.map(({ territory, phase }) => ({
    territoryId: territory.id,
    territoryLabel: territory.label,
    phaseId: phase.id,
    phaseTitle: phase.title,
  }))
}

/**
 * Order the territories a large expedition fishes, most worth fishing first.
 *
 * The creator's `fishingFocus` comes first, because naming a subsystem is the deliberate act and
 * a budget that cut it would be cutting the one thing they asked for. Size decides the rest: with
 * no scout rating relevance yet, the biggest territory is the one most likely to hide something,
 * and it is a fact the platform can compute rather than a judgement it would be inventing.
 */
export function prioritiseTerritories(
  territories: readonly BugFishingTerritory[],
  focus: string | null | undefined,
): BugFishingTerritory[] {
  const needles = (focus ?? '')
    .toLowerCase()
    .split(/[\s,;]+/)
    .map((needle) => needle.trim())
    .filter((needle) => needle.length >= 3)
  const focused = (territory: BugFishingTerritory): boolean =>
    needles.some(
      (needle) =>
        territory.label.toLowerCase().includes(needle) ||
        (territory.roots ?? []).some((root) => root.toLowerCase().includes(needle)),
    )
  return [...territories].sort((a, b) => {
    const byFocus = Number(focused(b)) - Number(focused(a))
    if (byFocus !== 0) return byFocus
    return (b.approxTokens ?? 0) - (a.approxTokens ?? 0)
  })
}
