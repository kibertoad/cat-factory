import type { AdoptionSurvey } from '@cat-factory/contracts'
import type { Logger, RepoFiles } from '@cat-factory/kernel'
import { getErrorMessage } from '@cat-factory/kernel'

// ---------------------------------------------------------------------------
// The DETERMINISTIC half of a monorepo bootstrap's survey: what the two sides actually
// contain, read through the checkout-free `RepoFiles` port.
//
// The platform computes this and the model only JUDGES it. That split is the whole reason the
// suggestion is worth reviewing: a recommendation is checkable against a named file a human can
// open, and a claim about a convention that cites nothing the survey read is dropped upstream
// (`parseAdoptionDecisions`) rather than shown as if the platform had verified it.
//
// Two rules shape the reads. Everything probed is a BOUNDED, declared list (no crawl, no
// recursive walk), so the cost of a survey does not scale with the size of the monorepo it is
// landing in. And every read that FAILS is recorded as unreadable rather than skipped, because a
// plan built without the monorepo's CI is materially weaker than one built with it, and only the
// survey can say which of the two a reviewer is looking at.
// ---------------------------------------------------------------------------

/**
 * The root-level files that carry a repository's conventions, in priority order.
 *
 * Cross-ecosystem on purpose: the flow is not JS-specific, and a Go or JVM monorepo whose
 * conventions this list cannot see would produce a survey that silently found "nothing", the
 * failure mode this whole module exists to avoid. Probed by INTERSECTION with a directory
 * listing, so naming a file no repository has costs nothing.
 */
const CONVENTION_FILES = [
  'package.json',
  'pnpm-workspace.yaml',
  'turbo.json',
  'nx.json',
  'lerna.json',
  'tsconfig.json',
  'tsconfig.base.json',
  'eslint.config.js',
  'eslint.config.mjs',
  '.eslintrc.json',
  '.oxlintrc.json',
  'biome.json',
  '.prettierrc',
  'vitest.config.ts',
  'jest.config.js',
  'go.work',
  'go.mod',
  'Cargo.toml',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'settings.gradle',
  'pyproject.toml',
  'requirements.txt',
  'Gemfile',
  'Makefile',
  'Justfile',
  'Dockerfile',
  'docker-compose.yml',
  'compose.yaml',
  'AGENTS.md',
  'CLAUDE.md',
  'CONTRIBUTING.md',
  'README.md',
] as const

/** Directory listings probed on the monorepo root for its CI wiring. */
const CI_DIRECTORIES = ['.github/workflows', '.gitlab-ci.yml', '.circleci'] as const

/**
 * How many candidate siblings are examined before one is chosen as the worked example.
 *
 * Bounded like every other read here, and >1 because the FIRST entry of a services directory is
 * not a service in any repository that also keeps tooling there: an alphabetical pick lands on
 * `.github`, `.changeset` or a `docs/` folder and then reports CI config to the reviewer as what
 * a service in this monorepo looks like. Dot-entries are excluded outright (below) and the rest
 * are probed in order until one holds a convention file of its own.
 */
const MAX_SIBLING_CANDIDATES = 4

/** Per-file content cap. A convention is legible from its opening; a lockfile-sized read is not. */
const MAX_FILE_CHARS = 6_000
/** How many root files one side contributes, most-conventional first. */
const MAX_ROOT_FILES = 14
/** How many files the worked-example sibling service contributes. */
const MAX_SIBLING_FILES = 10
/** How many CI workflow files are read (they repeat heavily past the first couple). */
const MAX_CI_FILES = 2

/** One side's reader: a bound `RepoFiles` plus the git ref to read it at. */
export interface SurveySide {
  files: RepoFiles
  /** Branch/sha to read at; undefined ⇒ the repo's default branch. */
  gitRef?: string | undefined
}

export interface MonorepoSurveyRequest {
  /** The monorepo the service is landing in. */
  monorepo: SurveySide
  /** The reference template, when the run has one (a from-scratch run has none). */
  template?: SurveySide | undefined
  /** The new service's subdirectory (e.g. `services/billing`). */
  directory: string
  logger?: Logger | undefined
}

export interface MonorepoSurveyResult {
  survey: AdoptionSurvey
  /** The read contents, keyed by the SAME prefixed path the survey and a decision's evidence use. */
  files: Record<string, string>
}

/** The parent directory a new service's siblings live in, or `''` for a root-level service. */
export function parentDirectoryOf(directory: string): string {
  const segments = directory.split('/').filter(Boolean)
  return segments.slice(0, -1).join('/')
}

/** Clip one file's content to the per-file cap, stating the clip rather than hiding it. */
function clip(content: string): string {
  if (content.length <= MAX_FILE_CHARS) return content
  return `${content.slice(0, MAX_FILE_CHARS)}\n…[truncated: ${
    content.length - MAX_FILE_CHARS
  } more characters not shown]`
}

/**
 * One side's reader, accumulating what it read and what it could not.
 *
 * `unreadable` is the load-bearing half. A `getFile` that THROWS is a provider failure (a
 * revoked token, a rate limit, an outage), and it is not the same fact as the file being absent
 * (which `getFile` reports as `null`). Collapsing the two would let a survey blinded by an
 * expired installation token present itself as a monorepo with no conventions.
 */
class SideReader {
  readonly read: string[] = []
  readonly unreadable: string[] = []
  readonly contents: Record<string, string> = {}

  constructor(
    private readonly side: SurveySide,
    private readonly prefix: 'monorepo' | 'template',
    private readonly logger: Logger | undefined,
  ) {}

  /** Entry names of a directory, or null when it could not be listed (recorded as unreadable). */
  async list(path: string): Promise<{ name: string; type: string; path: string }[] | null> {
    try {
      return await this.side.files.listDirectory(path, this.side.gitRef)
    } catch (error) {
      this.unreadable.push(`${path || '.'}/`)
      this.logger?.warn('monorepo survey: directory listing failed', {
        side: this.prefix,
        path,
        err: getErrorMessage(error),
      })
      return null
    }
  }

  /** Read one file into the survey; absent is silent, unreadable is recorded. */
  async take(path: string): Promise<void> {
    try {
      const file = await this.side.files.getFile(path, this.side.gitRef)
      if (!file) return
      this.read.push(path)
      this.contents[`${this.prefix}:${path}`] = clip(file.content)
    } catch (error) {
      this.unreadable.push(path)
      this.logger?.warn('monorepo survey: file read failed', {
        side: this.prefix,
        path,
        err: getErrorMessage(error),
      })
    }
  }

  /**
   * Record a directory's SHAPE as a citable survey entry.
   *
   * The listing is already in hand (nothing is re-read), and it is the only evidence the survey
   * has for `source-layout` and module structure: no root manifest states where a service puts
   * its code, its tests or its entry point, and the sibling's own config files do not either. A
   * recommendation about layout that cites nothing is dropped upstream as invention, so without
   * this the model can only ever answer `template` for one of the twelve areas it is asked
   * about. Recorded under the directory path with a trailing slash, so the key a decision cites
   * is visibly a listing rather than a file.
   */
  noteLayout(dir: string, entries: { name: string; type: string }[]): void {
    if (entries.length === 0) return
    // `./` for the root, matching how `list` names an unreadable root, so no key is a bare slash.
    const path = dir ? `${dir}/` : './'
    this.read.push(path)
    this.contents[`${this.prefix}:${path}`] = entries
      .map((entry) => `${entry.name}${entry.type === 'dir' ? '/' : ''}`)
      .sort()
      .join('\n')
  }

  /**
   * Read the convention files a listed directory actually holds, in the declared priority order
   * and capped. Reads run concurrently: the set is bounded and declared, so this is one fixed
   * fan-out rather than a loop that grows with the repository.
   */
  async takeConventionFiles(
    dir: string,
    entries: { name: string; type: string }[],
    limit: number,
  ): Promise<void> {
    const present = new Set(
      entries.filter((entry) => entry.type === 'file').map((entry) => entry.name),
    )
    const wanted = CONVENTION_FILES.filter((name) => present.has(name)).slice(0, limit)
    await Promise.all(wanted.map((name) => this.take(dir ? `${dir}/${name}` : name)))
  }
}

/**
 * Entries of `parent` that could plausibly be a sibling SERVICE, in probe order.
 *
 * Excludes the target itself, every dot-entry, and the CI directories the survey has already
 * read: `.github` sorts below every letter, so an alphabetical pick over a raw listing returns
 * it for any root-level target, and the reviewer is then told a workflows folder is "the best
 * available statement of what a service in this monorepo looks like".
 */
function siblingCandidates(
  entries: { name: string; type: string; path: string }[],
  directory: string,
): string[] {
  const excluded = new Set<string>(CI_DIRECTORIES)
  return entries
    .filter(
      (entry) =>
        entry.type === 'dir' &&
        entry.path !== directory &&
        !entry.name.startsWith('.') &&
        !excluded.has(entry.path),
    )
    .map((entry) => entry.path)
    .sort()
    .slice(0, MAX_SIBLING_CANDIDATES)
}

/**
 * Choose one existing sibling as the monorepo's worked example, read it, and return its path.
 *
 * A candidate has to actually look like a service: a directory holding no convention file of its
 * own says nothing about how a service here is built, and presenting it as the example is worse
 * than presenting none, because "no sibling" is a fact the plan REPORTS while a bad sibling is
 * one it asserts. Returns null when nothing qualifies, which the survey carries through as
 * `siblingService: null` and the prompt states outright.
 */
async function pickSiblingService(
  mono: SideReader,
  entries: { name: string; type: string; path: string }[] | null,
  directory: string,
): Promise<string | null> {
  if (!entries) return null
  for (const candidate of siblingCandidates(entries, directory)) {
    const own = await mono.list(candidate)
    if (!own) continue
    const names = new Set(own.filter((entry) => entry.type === 'file').map((entry) => entry.name))
    if (!CONVENTION_FILES.some((name) => names.has(name))) continue
    // The SHAPE first (it is the only evidence for layout), then the files themselves.
    mono.noteLayout(candidate, own)
    await mono.takeConventionFiles(candidate, own, MAX_SIBLING_FILES)
    return candidate
  }
  return null
}

/**
 * Survey both sides of a monorepo bootstrap: the house conventions the new service is landing
 * among, and what the reference template ships for the same areas.
 *
 * Three reads make up the monorepo half, and the third is the one that matters most: the root
 * config says what the repository declares, the CI workflows say what it enforces, and the
 * nearest EXISTING SIBLING service says what a service in this repository actually looks like,
 * which is the thing a new service has to match and the thing no root file states. When nothing
 * beside the target qualifies as a sibling service, that is reported (`siblingService: null`)
 * rather than filled with the first directory found, which is a claim the survey cannot support.
 *
 * Each side also contributes its own SHAPE (`noteLayout`), because the shape is the only evidence
 * either side offers about source layout and module structure. Both are read off listings the
 * survey already needed, so neither costs a request.
 */
export async function surveyMonorepo(
  request: MonorepoSurveyRequest,
): Promise<MonorepoSurveyResult> {
  const { directory, logger } = request
  const mono = new SideReader(request.monorepo, 'monorepo', logger)
  const template = request.template
    ? new SideReader(request.template, 'template', logger)
    : undefined

  // ---- the monorepo's root conventions -------------------------------------
  const rootEntries = await mono.list('')
  if (rootEntries) await mono.takeConventionFiles('', rootEntries, MAX_ROOT_FILES)

  // ---- what it enforces in CI ---------------------------------------------
  for (const ciPath of CI_DIRECTORIES) {
    if (ciPath.endsWith('.yml')) {
      await mono.take(ciPath)
      continue
    }
    const entries = await mono.list(ciPath)
    if (!entries) continue
    const workflows = entries
      .filter((entry) => entry.type === 'file')
      .slice(0, MAX_CI_FILES)
      .map((entry) => entry.path)
    await Promise.all(workflows.map((path) => mono.take(path)))
  }

  // ---- the nearest existing sibling service (the worked example) -----------
  const parent = parentDirectoryOf(directory)
  // Re-uses the root listing for a root-level target rather than asking for it twice.
  const siblingEntries = parent === '' ? rootEntries : await mono.list(parent)
  const sibling = await pickSiblingService(mono, siblingEntries, directory)

  // ---- the reference template ---------------------------------------------
  // Its SHAPE is recorded beside its files for the same reason the sibling's is: a layout
  // recommendation needs evidence on both sides, or the one side that has any wins by default.
  if (template) {
    const entries = await template.list('')
    if (entries) {
      template.noteLayout('', entries)
      await template.takeConventionFiles('', entries, MAX_ROOT_FILES)
    }
  }

  const survey: AdoptionSurvey = {
    monorepoPaths: mono.read,
    templatePaths: template?.read ?? [],
    unreadablePaths: [
      ...mono.unreadable.map((path) => `monorepo:${path}`),
      ...(template?.unreadable ?? []).map((path) => `template:${path}`),
    ],
    siblingService: sibling,
  }
  return { survey, files: { ...mono.contents, ...template?.contents } }
}
