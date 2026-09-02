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
 * Survey both sides of a monorepo bootstrap: the house conventions the new service is landing
 * among, and what the reference template ships for the same areas.
 *
 * Three reads make up the monorepo half, and the third is the one that matters most: the root
 * config says what the repository declares, the CI workflows say what it enforces, and the
 * nearest EXISTING SIBLING service says what a service in this repository actually looks like,
 * which is the thing a new service has to match and the thing no root file states. When the
 * target's parent directory holds no sibling yet, that is reported (`siblingService: null`)
 * rather than left to be inferred from a thinner plan.
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
  const siblingEntries = await mono.list(parent)
  const sibling = siblingEntries
    ?.filter((entry) => entry.type === 'dir' && entry.path !== directory)
    .map((entry) => entry.path)
    .sort()[0]
  if (sibling) {
    const own = await mono.list(sibling)
    if (own) await mono.takeConventionFiles(sibling, own, MAX_SIBLING_FILES)
  }

  // ---- the reference template ---------------------------------------------
  if (template) {
    const entries = await template.list('')
    if (entries) await template.takeConventionFiles('', entries, MAX_ROOT_FILES)
  }

  const survey: AdoptionSurvey = {
    monorepoPaths: mono.read,
    templatePaths: template?.read ?? [],
    unreadablePaths: [
      ...mono.unreadable.map((path) => `monorepo:${path}`),
      ...(template?.unreadable ?? []).map((path) => `template:${path}`),
    ],
    siblingService: sibling ?? null,
  }
  return { survey, files: { ...mono.contents, ...template?.contents } }
}
