import type {
  BlueprintService,
  BlueprintModule,
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
//
// THE FRAME, and it binds every path this module emits: a territory's roots and its manifest are
// relative to the SURVEY ROOT, which is the service's own directory in a monorepo and the
// repository root otherwise. That is the frame the agent works in — the harness roots its checkout
// at `<clone>/<serviceDirectory>` — so it is the frame the manifest has to be written in, the
// frame the pass reports its reads and its findings in, and therefore the frame the scope check
// and the coverage intersection have to judge in. A repo-relative manifest handed to a service
// agent lists paths it cannot open, and every finding it reports back lands outside every root.
// The tree read is repo-relative, so the prefix is stripped ONCE, here, in `fishableFiles`.
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

/**
 * The id and label stem for the files sitting DIRECTLY in a root, beside its sub-directories.
 *
 * They are a group in their own right rather than a claim on the root itself: see
 * {@link groupByChildDirectory} for why owning the root would be either an over-claim or, at the
 * survey root, nothing at all.
 */
const LOOSE_FILES_SEGMENT = 'root-files'

/** The label those loose files get, under a root and at the survey root. */
function looseFilesLabel(root: string): string {
  return root ? `${root} (files)` : 'Top-level files'
}

/**
 * Whether any of a candidate's roots is a directory carrying a package marker.
 *
 * Asked of every root rather than only of a lone one: a candidate that already packed two
 * directories together is exactly the one that must stop packing when the next is a package, and
 * the earlier "only when there is a single root" reading meant the first pack disabled the
 * boundary check for everything after it.
 */
function isPackageRoot(candidate: Candidate): boolean {
  return candidate.roots.some((root) => {
    const prefix = root ? `${root}/` : ''
    return candidate.files.some(
      (file) => file.path.startsWith(prefix) && PACKAGE_MARKERS.has(file.path.slice(prefix.length)),
    )
  })
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

/** One file of the survey's manifest: the path (survey-root-relative), and what it weighs. */
export interface SurveyedFile {
  path: string
  bytes: number
}

/** What a survey of the repository tree produced. */
export interface CodebaseSurvey {
  /** The partition, in the order the expedition fishes it. Always at least one entry. */
  territories: BugFishingTerritory[]
  /**
   * Every fishable file under the survey root, indexed by territory id, with paths in the survey
   * root's frame (see this module's header).
   */
  filesByTerritory: Map<string, SurveyedFile[]>
  /** True when the provider cut the tree short: the manifest is a prefix of the codebase. */
  treeTruncated: boolean
}

/** Options a survey takes beyond the tree itself. */
export interface SurveyOptions {
  /**
   * The monorepo subdirectory the service lives in, when it has one. The survey walks from here
   * rather than from the repository root: a sibling service's code is out of scope for an
   * expedition exactly as it is for every other run. It is also the frame every path this module
   * emits is relative to, because it is the directory the agent's checkout is rooted at.
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
 * The fishable FILES of a tree, scoped to the survey root, sized, and REBASED onto that root.
 *
 * Directories are dropped here rather than filtered at each later step: a territory is a set of
 * files, and a `dir` entry carries no bytes to size it with. The ignore rules are applied to the
 * FULL repo path, before the rebase, so `packages/api/dist` is still recognised as generated
 * output once the prefix is gone.
 */
function fishableFiles(entries: readonly RepoContentEntry[], root: string): SurveyedFile[] {
  const prefix = root ? `${root}/` : ''
  const files: SurveyedFile[] = []
  for (const entry of entries) {
    if (entry.type !== 'file') continue
    const path = normalizePath(entry.path)
    if (prefix && !path.startsWith(prefix)) continue
    if (!isFishablePath(path)) continue
    files.push({
      path: path.slice(prefix.length),
      bytes: typeof entry.size === 'number' ? entry.size : ASSUMED_FILE_BYTES,
    })
  }
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

/**
 * Shas of the tree's entries, keyed by normalised REPO-relative path.
 *
 * Directories and files both: a territory root is usually a directory, whose subtree sha answers
 * "has this changed since it was fished" with a string compare, but the loose-files group's roots
 * are individual files, and a blob sha answers exactly the same question about one of those.
 */
function entryShas(entries: readonly RepoContentEntry[]): Map<string, string> {
  const shas = new Map<string, string>()
  for (const entry of entries) {
    if (entry.sha) shas.set(normalizePath(entry.path), entry.sha)
  }
  return shas
}

function tokensOf(files: readonly SurveyedFile[]): number {
  return Math.round(files.reduce((sum, file) => sum + file.bytes, 0) / BYTES_PER_TOKEN)
}

/** The slug a territory id is built from: path-shaped, safe to read and to put in a log field. */
function territorySlug(idBase: string): string {
  const slug = idBase.replace(/[^a-zA-Z0-9._/-]/g, '-').replace(/\//g, '.')
  return slug || WHOLE_CODEBASE_TERRITORY_ID
}

/**
 * Stamp a territory id that no other territory of this survey carries.
 *
 * Ids are DERIVED from paths, and derived ids collide: two blueprint modules whose first reference
 * is the same directory produce the same stem, and so does a directory whose name happens to match
 * the loose-files stem. A collision is not cosmetic — `filesByTerritory` is keyed by id, so the
 * second territory would overwrite the first's manifest and every lookup by id would resolve both
 * to one set of roots. Suffixing is enough because an id only has to be stable and distinct WITHIN
 * one expedition: nothing looks a territory up across surveys (see the schema's note on why the
 * label and roots are recorded rather than re-derived).
 */
function uniqueTerritoryId(stem: string, used: Set<string>): string {
  let id = stem
  for (let n = 2; used.has(id); n++) id = `${stem}~${n}`
  used.add(id)
  return id
}

/** The label a human reads for a territory rooted at `root` (already in the survey frame). */
function labelForRoot(root: string): string {
  return root || 'Whole codebase'
}

/**
 * The single territory a codebase small enough to fish whole gets.
 *
 * The PASS-THROUGH: its phases carry no territory id, so the expedition is byte-for-byte the one
 * that shipped before territories existed. Large-codebase mode is a size threshold crossed, never
 * a mode a task opts into.
 */
export function wholeCodebaseTerritory(files: readonly SurveyedFile[]): BugFishingTerritory {
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

/** A set of files under one root: one child directory, or the files sitting directly in it. */
interface FileGroup {
  /** Sort key, so two surveys of the same tree order their groups identically. */
  key: string
  /** The stem the territory id is derived from. */
  idBase: string
  /** The prefixes this group owns, in the survey root's frame. */
  roots: string[]
  /** What a human reads for it. */
  label: string
  files: SurveyedFile[]
}

/**
 * Group a set of files by their first path segment BELOW `root`, so a directory stays whole
 * whenever it fits.
 *
 * Files sitting DIRECTLY in `root` form their own group, and that group owns its FILES rather than
 * `root`. Owning `root` would be an over-claim wherever `root` is a real directory — it is a prefix
 * over every sibling group here too, so a finding in one of them would be attributed to this one —
 * and at the SURVEY root, where `root` is the empty string, it is worse than that: read as a
 * prefix, the empty root matches no path at all, so every finding a pass raised on a top-level file
 * was dropped as out of scope, and the empty id it derived was falsy enough that the pass was
 * dispatched with no manifest and no scope in the first place.
 */
function groupByChildDirectory(files: readonly SurveyedFile[], root: string): FileGroup[] {
  const directories = new Map<string, SurveyedFile[]>()
  const loose: SurveyedFile[] = []
  const prefixLength = root ? root.length + 1 : 0
  for (const file of files) {
    const rest = file.path.slice(prefixLength)
    const slash = rest.indexOf('/')
    if (slash === -1) {
      loose.push(file)
      continue
    }
    const child = rest.slice(0, slash)
    const key = root ? `${root}/${child}` : child
    const bucket = directories.get(key)
    if (bucket) bucket.push(file)
    else directories.set(key, [file])
  }
  const groups: FileGroup[] = [...directories.entries()].map(([key, groupFiles]) => ({
    key,
    idBase: key,
    roots: [key],
    label: labelForRoot(key),
    files: groupFiles,
  }))
  if (loose.length > 0) {
    groups.push({
      // A trailing slash sorts the loose group immediately before the child directories of the
      // same root, and the survey root's loose group first of all.
      key: root ? `${root}/` : '',
      idBase: root ? `${root}/${LOOSE_FILES_SEGMENT}` : LOOSE_FILES_SEGMENT,
      roots: loose.map((file) => file.path),
      label: looseFilesLabel(root),
      files: loose,
    })
  }
  return groups.sort((a, b) => a.key.localeCompare(b.key))
}

/** A candidate territory before it is stamped with an id. */
interface Candidate {
  /** The stem the territory id is derived from, before de-duplication. */
  idBase: string
  /** Repo-relative (survey-framed) prefixes the territory owns: directories, or single files. */
  roots: string[]
  /** One label per group packed in, joined for the territory label. */
  labels: string[]
  files: SurveyedFile[]
  source: 'blueprint' | 'directory'
}

/** A file group as a directory-sourced candidate. */
function directoryCandidate(group: FileGroup): Candidate {
  return {
    idBase: group.idBase,
    roots: group.roots,
    labels: [group.label],
    files: group.files,
    source: 'directory',
  }
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
    // A multi-root candidate over the ceiling is a blueprint module spanning several references
    // (packing runs after this), so give each reference its own territory rather than chopping the
    // module at a file boundary.
    return candidate.roots
      .map((r): Candidate => ({
        idBase: r,
        roots: [r],
        labels: [labelForRoot(r)],
        files: candidate.files.filter((f) => f.path === r || f.path.startsWith(`${r}/`)),
        source: candidate.source,
      }))
      .filter((unpacked) => unpacked.files.length > 0)
      .flatMap(splitOversized)
  }
  const groups = groupByChildDirectory(candidate.files, root)
  if (groups.length <= 1) return [candidate]
  return groups.flatMap((group) =>
    splitOversized({ ...directoryCandidate(group), source: candidate.source }),
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
      previous.labels.push(...candidate.labels)
      previous.files.push(...candidate.files)
      continue
    }
    packed.push({
      idBase: candidate.idBase,
      roots: [...candidate.roots],
      labels: [...candidate.labels],
      files: [...candidate.files],
      source: candidate.source,
    })
  }
  return packed
}

/**
 * A blueprint module's references, in the SURVEY root's frame.
 *
 * A reference is written by whoever ran the Blueprinter, and the two authorings differ by exactly
 * the service prefix: an agent rooted at the service directory writes `src/billing`, while one
 * that saw the repository root writes `packages/api/src/billing`. Both name the same code, so the
 * prefix is stripped where it is present rather than assumed either way. A reference that matches
 * nothing is dropped downstream, which is what makes normalising safe: nothing here can move a
 * module onto code it does not name.
 */
function blueprintReferenceRoots(module: BlueprintModule, serviceRoot: string): string[] {
  return (module.references ?? [])
    .map((reference) => normalizePath(reference))
    .map((reference) =>
      serviceRoot && (reference === serviceRoot || reference.startsWith(`${serviceRoot}/`))
        ? reference.slice(serviceRoot.length).replace(/^\/+/, '')
        : reference,
    )
    .filter((reference) => reference.length > 0)
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
    const roots = blueprintReferenceRoots(module, serviceRoot)
    const moduleFiles = files.filter(
      (file) =>
        !claimed.has(file.path) &&
        roots.some((root) => file.path === root || file.path.startsWith(`${root}/`)),
    )
    if (moduleFiles.length === 0) continue
    for (const file of moduleFiles) claimed.add(file.path)
    // The module NAME is both the better label and the better id stem: it is what the person who
    // decomposed the service called this, and unlike the first reference it distinguishes two
    // modules that happen to share one.
    const name = module.name?.trim() ?? ''
    candidates.push({
      idBase: name || (roots[0] ?? ''),
      roots,
      labels: [name || roots.map(labelForRoot).join(', ')],
      files: moduleFiles,
      source: 'blueprint',
    })
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
  const shas = entryShas(tree.entries)
  const filesByTerritory = new Map<string, SurveyedFile[]>()

  if (tokensOf(files) <= MAX_TERRITORY_TOKENS) {
    const only = wholeCodebaseTerritory(files)
    filesByTerritory.set(only.id, files)
    return { territories: [only], filesByTerritory, treeTruncated: tree.truncated }
  }

  const blueprint = options.blueprint
    ? blueprintCandidates(files, options.blueprint, serviceRoot)
    : { candidates: [] as Candidate[], unclaimed: files }
  const byDirectory = groupByChildDirectory(blueprint.unclaimed, '').map(directoryCandidate)

  const candidates = packSmall(
    [...blueprint.candidates, ...byDirectory].flatMap((candidate) => splitOversized(candidate)),
  )
  const usedIds = new Set<string>()
  const territories = candidates.map((candidate): BugFishingTerritory => {
    const id = uniqueTerritoryId(territorySlug(candidate.idBase), usedIds)
    filesByTerritory.set(id, candidate.files)
    return {
      id,
      label: candidate.labels.join(', '),
      roots: candidate.roots,
      fileCount: candidate.files.length,
      approxTokens: tokensOf(candidate.files),
      source: candidate.source,
      // The sha map is keyed in the tree's own repo-relative frame, so the survey-framed root goes
      // back through the service prefix to look itself up.
      subtreeShas: candidate.roots.map(
        (root) => shas.get(serviceRoot ? `${serviceRoot}/${root}` : root) ?? '',
      ),
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
  const only = territories[0]
  if (territories.length === 0 || (territories.length === 1 && only?.source === 'whole-codebase')) {
    // The whole-codebase branch names its cut cells from the ANGLES rather than from a cell list,
    // because a survey that could not read the repository hands over no territory to build cells
    // from — and the budget can cut angles all the same. Deriving the tail from the cells left the
    // one case the record exists for, a cut nobody can see, as the one case it did not cover.
    return {
      phases: angles.slice(0, passBudget),
      unfished: angles.slice(passBudget).map((phase) => ({
        territoryId: only?.id ?? WHOLE_CODEBASE_TERRITORY_ID,
        territoryLabel: only?.label ?? 'Whole codebase',
        phaseId: phase.id,
        phaseTitle: phase.title,
      })),
      plannedCells: angles.length,
    }
  }
  const cells: PlannedCell[] = territories.flatMap((territory) =>
    angles.map((phase) => ({ territory, phase })),
  )
  const kept = cells.slice(0, passBudget)
  return {
    phases: kept.map(({ territory, phase }) => ({
      ...phase,
      territoryId: territory.id,
      territoryLabel: territory.label,
    })),
    unfished: unfishedFor(cells.slice(passBudget)),
    plannedCells: cells.length,
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
