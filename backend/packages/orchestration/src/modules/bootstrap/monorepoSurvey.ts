import type { AdoptionExploration, AdoptionRead, AdoptionSurvey } from '@cat-factory/contracts'
import { MAX_ADOPTION_READ_PATH, MAX_ADOPTION_READS } from '@cat-factory/contracts'
import type {
  Logger,
  MonorepoAdoptionExplorer,
  MonorepoAdoptionSide,
  MonorepoExplorationAnswer,
  MonorepoExplorationRequest,
  RepoFiles,
} from '@cat-factory/kernel'
import { getErrorMessage, redactSecrets } from '@cat-factory/kernel'

// ---------------------------------------------------------------------------
// A monorepo bootstrap's SURVEY: what the two sides actually contain, read through the
// checkout-free `RepoFiles` port.
//
// The read is in two halves, and the split is the whole design. The platform SEEDS an opening
// context (each side's root listing and the convention files it really holds, whichever CI
// declaration its provider uses, and the listing of every sibling that looks like a service),
// because there is no reason to spend model calls rediscovering `package.json` and it keeps the
// cheap case cheap. The MODEL then widens it: it asks for the CI workflow that will actually gate
// the pull request, follows a dependency into the shared package that says what adopting it
// entails, and opens a second and a third sibling when the first two disagree. None of that is
// enumerable in advance, which is why the previous declared list decided what the survey could
// not see before it looked.
//
// What the platform keeps is the BOOKKEEPING. Every read, seeded or model-chosen, is budgeted,
// scrubbed and appended to ONE transcript, and that transcript is what the plan carries, so a
// recommendation stays checkable against a record the model could not write
// (`parseAdoptionDecisions` drops a citation naming anything the transcript does not hold as
// READ). The bound is a call ceiling plus a character ceiling rather than a declared path list,
// so the cost of a survey still does not scale with the size of the monorepo it lands in.
//
// Every read that FAILS is recorded as unreadable rather than skipped, and one the platform
// declines is recorded as refused: a plan built without the monorepo's CI is materially weaker
// than one built with it, and only the transcript can say which of the two a reviewer has.
// ---------------------------------------------------------------------------

/**
 * The root-level files that carry a repository's conventions, in priority order.
 *
 * Cross-ecosystem on purpose: the flow is not JS-specific, and a Go or JVM monorepo whose
 * conventions this list cannot see would produce a seed that silently found "nothing", the
 * failure mode this whole module exists to avoid. Probed by INTERSECTION with a directory
 * listing, so naming a file no repository has costs nothing.
 *
 * Still a declared list, and deliberately so: it is the OPENING context and the test a candidate
 * directory has to pass to count as a service, not the boundary of what the survey can see.
 * Anything it misses, the model can go and read.
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

/**
 * The CI directories the seed LISTS (never reads), each gated on the root entry that holds it.
 *
 * Listing rather than reading is the correction the tool loop makes possible: a monorepo with
 * reusable workflows plus thirty per-service ones used to contribute an arbitrary two, and what
 * a new directory is actually REQUIRED to satisfy (a path filter, a required check) was likely
 * in one of the twenty-eight nobody read. The listing is the menu; the model picks off it.
 *
 * Every provider the platform pushes to is named, for the same reason {@link CONVENTION_FILES}
 * is cross-ecosystem: a GitLab-hosted monorepo has no `.github` at all, so a seed that knows
 * only GitHub hands the model an opening context with NO CI in it and leaves the `ci` area with
 * nothing citable on exactly the deployments this platform supports as first-class. Probed by
 * intersection with the root listing, so naming a provider no repository here uses costs nothing.
 */
const CI_DIRECTORIES = [
  { rootEntry: '.github', path: '.github/workflows' },
  { rootEntry: '.circleci', path: '.circleci' },
] as const

/**
 * CI declarations that are a single root FILE, so there is no directory to offer as a menu.
 *
 * Read outside the {@link MAX_ROOT_FILES} convention cap deliberately: this is the whole of what
 * its provider says about CI, and losing it to fourteen manifests would leave the `ci` area
 * unevidenced on a repository that states its pipeline perfectly clearly.
 */
const CI_FILES = ['.gitlab-ci.yml'] as const

/**
 * How many sibling directories are probed as candidate worked examples.
 *
 * Higher than the old pick-one probe because the seed no longer reads their files: a candidate
 * costs one listing, and offering several is what makes a monorepo whose services DISAGREE
 * representable at all. Dot-entries are excluded outright, and a candidate qualifies only by
 * holding a convention file of its own.
 */
const MAX_SIBLING_CANDIDATES = 6

/**
 * Per-BODY content cap, on a directory listing as much as on a file.
 *
 * A convention is legible from its opening and a lockfile-sized read is not, and the same bound
 * has to reach a listing: a generated or vendored directory with five thousand entries renders a
 * body two budgets wide, which the exploration charge can only answer by refusing, latching
 * `exhausted` and reporting a survey that spent almost nothing as one that ran out of content.
 */
const MAX_FILE_CHARS = 6_000
/** How many root files one side contributes to the opening context, most-conventional first. */
const MAX_ROOT_FILES = 14

/**
 * The opening context's TOTAL character budget, split into an equal reservation per side.
 *
 * Spent in key order it would not be a bound at all but a handover to whichever side sorts
 * first, and `monorepo:` sorts before `template:` for every key: a large monorepo would spend
 * the whole allowance and the template would land entirely refused, which is exactly the
 * crowding-out this exists to prevent. So a run with no template reserves all of it for the
 * monorepo and a run with one gives each side half, spent in its own priority order; whatever a
 * side leaves unspent carries to the next, which makes the reservation a floor rather than a cap.
 */
const MAX_SEED_CHARS = 36_000

/** How many reads the MODEL may ask for. The loop's hard ceiling; see {@link AdoptionExploration}. */
const MAX_EXPLORATION_CALLS = 24
/** How many characters the model's own reads may spend, on top of the seed's reservation. */
const MAX_EXPLORATION_CHARS = 54_000

/** The bounds a survey answers to. Overridable so a test can drive exhaustion cheaply. */
export interface SurveyLimits {
  maxExplorationCalls: number
  maxExplorationChars: number
  maxSeedChars: number
  maxFileChars: number
}

const DEFAULT_LIMITS: SurveyLimits = {
  maxExplorationCalls: MAX_EXPLORATION_CALLS,
  maxExplorationChars: MAX_EXPLORATION_CHARS,
  maxSeedChars: MAX_SEED_CHARS,
  maxFileChars: MAX_FILE_CHARS,
}

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
  /** Bound overrides; the defaults are the constants above. */
  limits?: Partial<SurveyLimits> | undefined
}

/** The parent directory a new service's siblings live in, or `''` for a root-level service. */
export function parentDirectoryOf(directory: string): string {
  const segments = directory.split('/').filter(Boolean)
  return segments.slice(0, -1).join('/')
}

/**
 * The longest raw path a model may ask for.
 *
 * Derived from the contract rather than restated: what the transcript records is the PREFIXED
 * key, so the longest side name and a listing's trailing slash both have to fit inside
 * {@link MAX_ADOPTION_READ_PATH} beside the path itself. Restating 400 here emitted a row the
 * schema calls too long for any path over 390.
 */
const MAX_SURVEY_PATH = MAX_ADOPTION_READ_PATH - 'template:'.length - 1

/**
 * A repository-relative path the platform is willing to fetch, or the reason it will not.
 *
 * The path is MODEL-AUTHORED and is interpolated into the VCS contents API's URL, so it is
 * validated for magic rather than only for traversal, and both halves of that bite:
 *
 *  - a control character or a backslash means the model is guessing at a shell or a Windows
 *    path, and answering "not found" would tell it the repository lacks a file it never actually
 *    asked for;
 *  - `?`, `#` and `%` are the URL's own syntax, and the caller appends its `?ref=` AFTER this
 *    path. A `#` truncates the request to a DIFFERENT file while the transcript records the whole
 *    string as read, so a citation lands on the plan pointing at a path no reviewer can open; a
 *    `?ref=` of the model's own is honoured over the branch the survey believes it is reading;
 *    and a percent escape puts the traversal check below on the wrong side of the decoding the
 *    host, not this process, performs.
 *
 * A refusal is REPORTED (it lands on the transcript and the model is told), never a silent
 * shortening.
 */
export function normalizeSurveyPath(raw: string): { path: string } | { refused: string } {
  const trimmed = raw.trim().replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '')
  if (trimmed.length > MAX_SURVEY_PATH) {
    return { refused: 'the path is too long to be a repository path' }
  }
  if (trimmed.includes('\\') || [...trimmed].some((ch) => ch.charCodeAt(0) < 0x20)) {
    return { refused: 'the path contains characters that are not part of a repository path' }
  }
  if (/[?#%]/.test(trimmed)) {
    return {
      refused: 'the path contains URL syntax (? # or %), which is not part of a repository path',
    }
  }
  const segments = trimmed.split('/')
  if (segments.some((segment) => segment === '..')) {
    return { refused: 'the path leaves the repository; give a path relative to its root' }
  }
  return { path: segments.filter((segment) => segment !== '.').join('/') }
}

/** The citable key one read produces: `<side>:<path>`, with a trailing `/` marking a listing. */
function keyFor(side: MonorepoAdoptionSide, kind: 'list' | 'read', path: string): string {
  if (kind === 'read') return `${side}:${path}`
  // `./` for the root, so a listing always reads as one and no key ends in a bare colon.
  return `${side}:${path ? `${path}/` : './'}`
}

/** Clip one file's content to the per-file cap, stating the clip rather than hiding it. */
function clip(content: string, max: number): string {
  if (content.length <= max) return content
  return `${content.slice(0, max)}\n…[truncated: ${content.length - max} more characters not shown]`
}

/**
 * Render a directory's entries as the body a decision can cite for layout, under the same
 * per-body cap a file read answers to.
 *
 * Uncapped, one listing of a generated directory could be wider than the whole exploration
 * budget, and the only answer a charge has to a body it cannot fit is to refuse it and latch
 * `exhausted`, reporting a content budget that ran out when nothing had been spent.
 */
function renderListing(entries: { name: string; type: string }[], max: number): string {
  return clip(
    entries
      .map((entry) => `${entry.name}${entry.type === 'dir' ? '/' : ''}`)
      .sort()
      .join('\n'),
    max,
  )
}

/** A body fetched during the seed, awaiting the per-side reservation that decides if it fits. */
interface SeedCandidate {
  key: string
  body: string
}

/** What one side's reader produced, before the reservation is applied. */
interface SeedHarvest {
  candidates: SeedCandidate[]
  /** Sibling service directories this side offered (monorepo only). */
  siblings: string[]
}

/**
 * One side's raw reader: performs the IO, hands bodies and failures to the ledger.
 *
 * `unreadable` is the load-bearing distinction. A `getFile` that THROWS is a provider failure (a
 * revoked token, a rate limit, an outage), and it is not the same fact as the file being absent
 * (which `getFile` reports as `null`). Collapsing the two would let a survey blinded by an
 * expired installation token present itself as a monorepo with no conventions.
 */
class SideReader {
  constructor(
    private readonly side: SurveySide,
    readonly prefix: MonorepoAdoptionSide,
  ) {}

  /** Entry names of a directory, or the failure that stopped the listing. */
  async list(
    path: string,
  ): Promise<{ entries: { name: string; type: string; path: string }[] } | { failed: string }> {
    try {
      return { entries: await this.side.files.listDirectory(path, this.side.gitRef) }
    } catch (error) {
      return { failed: getErrorMessage(error) }
    }
  }

  /** One file's content, `null` when it is simply absent, or the failure that stopped the read. */
  async read(path: string): Promise<{ content: string | null } | { failed: string }> {
    try {
      const file = await this.side.files.getFile(path, this.side.gitRef)
      return { content: file ? file.content : null }
    } catch (error) {
      return { failed: getErrorMessage(error) }
    }
  }
}

/**
 * A monorepo survey in progress: the transcript, the budgets, and the reader the model widens it
 * through.
 *
 * Created before the model is asked anything, seeded once, then handed to the advisor. The
 * caller re-reads {@link survey} AFTER the advisor returns, because the transcript is what the
 * model actually fetched rather than what the platform predicted it would need.
 */
export class MonorepoSurveySession implements MonorepoAdoptionExplorer {
  private readonly limits: SurveyLimits
  private readonly readers: Partial<Record<MonorepoAdoptionSide, SideReader>>
  private readonly log: Logger | undefined
  private readonly reads: AdoptionRead[] = []
  private readonly bodies: Record<string, string> = {}
  /**
   * Seed bodies that were FETCHED but did not fit the opening context's reservation.
   *
   * Held rather than dropped: the prompt names them and tells the model to ask, so throwing the
   * bytes away buys a second contents-API round trip for content this process is already
   * holding. Kept OUT of {@link bodies} so nothing is citable before it has actually been served,
   * and out of {@link seedKeys} so it stays out of the opening prompt.
   */
  private readonly withheld: Record<string, string> = {}
  private readonly seedKeys = new Set<string>()
  private siblings: string[] = []
  private calls = 0
  private explorationChars = 0
  private recordsDropped = 0
  private exhausted: AdoptionExploration['exhausted'] = null

  constructor(private readonly request: MonorepoSurveyRequest) {
    this.limits = { ...DEFAULT_LIMITS, ...request.limits }
    this.log = request.logger
    this.readers = {
      monorepo: new SideReader(request.monorepo, 'monorepo'),
      ...(request.template ? { template: new SideReader(request.template, 'template') } : {}),
    }
  }

  get sides(): readonly MonorepoAdoptionSide[] {
    return Object.keys(this.readers) as MonorepoAdoptionSide[]
  }

  /** The transcript, the siblings offered, and what the exploration spent, as of right now. */
  survey(): AdoptionSurvey {
    return {
      reads: [...this.reads],
      siblingServices: [...this.siblings],
      exploration: {
        calls: this.calls,
        maxCalls: this.limits.maxExplorationCalls,
        chars: this.explorationChars,
        maxChars: this.limits.maxExplorationChars,
        exhausted: this.exhausted,
        recordsDropped: this.recordsDropped,
      },
    }
  }

  /**
   * The bodies rendered into the model's OPENING prompt.
   *
   * Only the seeded ones: everything the model fetches afterwards reaches it as that tool call's
   * own result, and folding those into the prompt too would send each body twice.
   */
  seedFiles(): Record<string, string> {
    const seeded: Record<string, string> = {}
    for (const key of this.seedKeys) {
      const body = this.bodies[key]
      if (body !== undefined) seeded[key] = body
    }
    return seeded
  }

  /**
   * Record something the platform could not even attempt, so it does not read as an absence.
   *
   * The one caller is a reference template the workspace's source-control connection could not
   * read when the survey ran: a grant revoked while the run sat in its queue, a provider outage,
   * or a deployment that lost the component that answers the question. The run was pre-flighted
   * against the same reach before it was recorded, so this is the narrow window rather than the
   * normal case, and it has to be SAID: "the template ships nothing for this area" and "nobody
   * looked at the template" lead a reviewer to opposite conclusions.
   */
  noteUnavailable(side: MonorepoAdoptionSide, path: string, note: string): void {
    this.record({ path: `${side}:${path}`, origin: 'seed', outcome: 'unreadable', chars: 0, note })
  }

  /**
   * Read the opening context: each side's root, the CI directory, and every sibling that looks
   * like a service.
   *
   * The sibling probe is the read no root file can stand in for, and it is a LIST rather than a
   * pick. One sibling is a sample of size one, so a monorepo with a six-year-old Java service
   * beside three new TypeScript ones has no single house convention, and naming whichever
   * directory sorted first reports a disagreement as though it were the answer. Dot-entries are
   * excluded (`.github` sorts below every letter, so an alphabetical pick landed on a workflows
   * folder for any root-level target) and a candidate qualifies only by holding a convention file
   * of its own.
   */
  async seed(): Promise<void> {
    const harvests: { reader: SideReader; harvest: SeedHarvest }[] = []
    const mono = this.readers.monorepo
    if (mono) harvests.push({ reader: mono, harvest: await this.seedMonorepo(mono) })
    const template = this.readers.template
    if (template) harvests.push({ reader: template, harvest: await this.seedTemplate(template) })
    this.commitSeed(harvests.map((entry) => entry.harvest))
  }

  private async seedMonorepo(reader: SideReader): Promise<SeedHarvest> {
    const candidates: SeedCandidate[] = []
    const root = await this.seedRoot(reader, candidates)
    const parent = parentDirectoryOf(this.request.directory)
    // Re-uses the root listing for a root-level target rather than asking for it twice. The
    // parent's own listing contributes no citable entry (the empty candidate sink): it is the
    // MENU the sibling probe reads, and each qualifying sibling's listing carries the layout
    // evidence. A failure to list it is still recorded, because "no siblings" and "could not see
    // whether there are siblings" are opposite facts.
    const siblingEntries = parent === '' ? root : await this.listInto(reader, parent, [])
    const siblings = await this.probeSiblings(reader, siblingEntries, candidates)
    return { candidates, siblings }
  }

  private async seedTemplate(reader: SideReader): Promise<SeedHarvest> {
    const candidates: SeedCandidate[] = []
    await this.seedRoot(reader, candidates)
    return { candidates, siblings: [] }
  }

  /**
   * What BOTH sides contribute: the root listing, the conventions it holds, and its CI.
   *
   * Shared rather than the monorepo's alone, because `ci` is a decision BETWEEN the two sides and
   * a seed that evidences only one of them biases it in the direction the prompt spends a
   * paragraph forbidding: an area nothing was read about is not an area the other side wins.
   */
  private async seedRoot(
    reader: SideReader,
    candidates: SeedCandidate[],
  ): Promise<{ name: string; type: string; path: string }[] | null> {
    const root = await this.listInto(reader, '', candidates)
    if (!root) return null
    await this.takeRootFiles(reader, root, candidates)
    for (const ci of CI_DIRECTORIES) {
      if (root.some((entry) => entry.name === ci.rootEntry)) {
        await this.listInto(reader, ci.path, candidates)
      }
    }
    return root
  }

  /**
   * List a directory, recording the listing as a citable seed entry.
   *
   * The listing costs no extra request (it is the one the seed already needed) and it is the only
   * evidence either side offers about source layout and module structure: no root manifest states
   * where a service puts its code, its tests or its entry point. Without it, a `source-layout`
   * recommendation cites nothing and is dropped upstream as invention, so `template` was the only
   * answer the model could legitimately give for that area on every monorepo.
   */
  private async listInto(
    reader: SideReader,
    path: string,
    candidates: SeedCandidate[],
  ): Promise<{ name: string; type: string; path: string }[] | null> {
    const key = keyFor(reader.prefix, 'list', path)
    const result = await reader.list(path)
    if ('failed' in result) {
      this.noteListingFailure(reader, path, result.failed)
      return null
    }
    if (result.entries.length === 0) {
      this.record({
        path: key,
        origin: 'seed',
        outcome: 'absent',
        chars: 0,
        note: 'the directory is empty or does not exist',
      })
      return result.entries
    }
    candidates.push({ key, body: renderListing(result.entries, this.limits.maxFileChars) })
    return result.entries
  }

  /**
   * A seed listing that FAILED: warned and recorded as unreadable, never skipped.
   *
   * Shared with the sibling probe, which is the read where skipping costs the most. "No sibling
   * service" is the strongest claim the opening context makes about a monorepo (it tells the
   * model there is no worked example and it tells the reviewer the survey saw root conventions
   * only), so a probe blinded by a revoked token or a rate limit has to say so rather than
   * produce the sentence a genuinely flat repository produces.
   */
  private noteListingFailure(reader: SideReader, path: string, cause: string): void {
    this.log?.warn('monorepo survey: directory listing failed', {
      side: reader.prefix,
      path,
      err: cause,
    })
    this.record({
      path: keyFor(reader.prefix, 'list', path),
      origin: 'seed',
      outcome: 'unreadable',
      chars: 0,
      note: cause,
    })
  }

  /**
   * The root files one side contributes: its conventions, capped in priority order, plus any
   * single-file CI declaration.
   *
   * The two lists are read together but capped apart. A CI file competing for the convention cap
   * would be crowded out by fourteen manifests on exactly the repositories whose CI is a single
   * file, which is the `ci` area losing its only evidence to a tie-break nobody chose.
   */
  private async takeRootFiles(
    reader: SideReader,
    entries: { name: string; type: string }[],
    candidates: SeedCandidate[],
  ): Promise<void> {
    const present = new Set(
      entries.filter((entry) => entry.type === 'file').map((entry) => entry.name),
    )
    await this.takeFiles(
      reader,
      '',
      [
        ...CONVENTION_FILES.filter((name) => present.has(name)).slice(0, MAX_ROOT_FILES),
        ...CI_FILES.filter((name) => present.has(name)),
      ],
      candidates,
    )
  }

  /** Read a named set of files a directory actually holds, in the order they were named. */
  private async takeFiles(
    reader: SideReader,
    dir: string,
    wanted: string[],
    candidates: SeedCandidate[],
  ): Promise<void> {
    // One fixed fan-out: the set is bounded and declared, so this never grows with the repository.
    const results = await Promise.all(
      wanted.map(async (name) => {
        const path = dir ? `${dir}/${name}` : name
        return { path, result: await reader.read(path) }
      }),
    )
    for (const { path, result } of results) {
      const key = keyFor(reader.prefix, 'read', path)
      if ('failed' in result) {
        this.log?.warn('monorepo survey: file read failed', {
          side: reader.prefix,
          path,
          err: result.failed,
        })
        this.record({
          path: key,
          origin: 'seed',
          outcome: 'unreadable',
          chars: 0,
          note: result.failed,
        })
        continue
      }
      // Absent is silent here: the set was intersected with a real listing, so a null means the
      // entry vanished between the two calls, which says nothing a reviewer needs.
      if (result.content === null) continue
      candidates.push({ key, body: clip(this.scrub(result.content), this.limits.maxFileChars) })
    }
  }

  /**
   * List every plausible sibling service, keeping the ones that hold a convention file.
   *
   * Excludes the target itself and every dot-entry (which is also what keeps the CI folder out,
   * since a listing's entries are one level deep): a directory that says nothing about how a
   * service here is built is worse than no example, because "no sibling" is a fact the plan
   * REPORTS while a bad sibling is one it asserts.
   *
   * One bounded fan-out rather than a loop of awaits, the shape {@link takeFiles} already uses:
   * the candidate set is capped above, so six sequential round trips to the VCS host sat in the
   * opening context's critical path for nothing.
   */
  private async probeSiblings(
    reader: SideReader,
    entries: { name: string; type: string; path: string }[] | null,
    candidates: SeedCandidate[],
  ): Promise<string[]> {
    if (!entries) return []
    const target = this.request.directory
    const probes = entries
      .filter(
        (entry) => entry.type === 'dir' && entry.path !== target && !entry.name.startsWith('.'),
      )
      .map((entry) => entry.path)
      .sort()
      .slice(0, MAX_SIBLING_CANDIDATES)
    const listings = await Promise.all(
      probes.map(async (path) => ({ path, result: await reader.list(path) })),
    )
    const qualifying: string[] = []
    for (const { path, result } of listings) {
      if ('failed' in result) {
        this.noteListingFailure(reader, path, result.failed)
        continue
      }
      const names = new Set(result.entries.filter((e) => e.type === 'file').map((e) => e.name))
      if (!CONVENTION_FILES.some((name) => names.has(name))) continue
      qualifying.push(path)
      candidates.push({
        key: keyFor(reader.prefix, 'list', path),
        body: renderListing(result.entries, this.limits.maxFileChars),
      })
    }
    return qualifying
  }

  /**
   * Apply the per-side reservation to everything the seed fetched, and record the result.
   *
   * A body that does not fit is recorded `refused` rather than dropped, for the same reason the
   * survey reports what it could not read: the model must not treat a file it was never shown as
   * a file that does not exist, and the reviewer sees the same list. The BYTES are kept even so
   * (see {@link withheld}), because the note invites the model to ask for them and re-fetching
   * what is already in memory is a round trip for nothing. Whatever an earlier side leaves
   * unspent carries forward, so the reservation is a floor rather than a ceiling.
   */
  private commitSeed(harvests: SeedHarvest[]): void {
    const share = Math.floor(this.limits.maxSeedChars / Math.max(1, harvests.length))
    let spare = this.limits.maxSeedChars - share * harvests.length
    for (const harvest of harvests) {
      this.siblings = [...this.siblings, ...harvest.siblings]
      let budget = share + spare
      for (const candidate of harvest.candidates) {
        if (candidate.body.length > budget) {
          this.withheld[candidate.key] = candidate.body
          this.record({
            path: candidate.key,
            origin: 'seed',
            outcome: 'refused',
            chars: 0,
            note: 'read, but it did not fit the opening context; ask for it if you need it',
          })
          continue
        }
        budget -= candidate.body.length
        this.bodies[candidate.key] = candidate.body
        this.seedKeys.add(candidate.key)
        this.record({
          path: candidate.key,
          origin: 'seed',
          outcome: 'read',
          chars: candidate.body.length,
          note: null,
        })
      }
      spare = budget
    }
  }

  /**
   * One model-chosen read, charged against the exploration budget.
   *
   * The call is counted BEFORE anything else, refusals included: a model emitting nonsense paths
   * would otherwise loop until the step cap fired, having read nothing. Budget exhaustion is
   * answered rather than thrown, so the model is told what it has left and can produce a plan
   * that says which areas it ran short on, instead of the loop ending with no reply at all.
   */
  async explore(request: MonorepoExplorationRequest): Promise<MonorepoExplorationAnswer> {
    this.calls += 1
    const reader = this.readers[request.side]
    if (!reader) {
      return this.refuse(request, `there is no ${request.side} repository in this run to read`)
    }
    if (this.calls > this.limits.maxExplorationCalls) {
      this.exhausted = 'calls'
      return this.refuse(
        request,
        `the exploration budget is spent (${this.limits.maxExplorationCalls} reads). Answer from ` +
          `what you have already seen, and say in the rationale which areas you could not check`,
      )
    }
    const normalized = normalizeSurveyPath(request.path)
    if ('refused' in normalized) return this.refuse(request, normalized.refused)
    const path = normalized.path
    if (request.kind === 'read' && path === '') {
      return this.refuse(request, 'name the file to read, relative to the repository root')
    }
    // The new service does not exist yet, but a RETRY surveying after a partial run would find
    // whatever the previous attempt left there. Reading it back as the monorepo's established
    // convention is the platform citing its own draft to itself.
    if (request.side === 'monorepo' && this.isInsideTarget(path)) {
      return this.refuse(
        request,
        `${this.request.directory} is the service being created, not an existing one; read a sibling instead`,
      )
    }
    const key = keyFor(request.side, request.kind, path)
    const cached = this.bodies[key]
    // Already fetched (seeded, or asked for twice): answer from what was read rather than
    // spending a second read of the same bytes on a bounded budget. No new transcript row, since
    // it names a read already recorded; the CALL is still counted, so a model re-requesting the
    // same file cannot buy itself an unbounded loop.
    if (cached !== undefined) {
      return { outcome: 'read', body: cached, note: null, key }
    }
    // Fetched during the seed but never shown, so the model taking the prompt's advice and asking
    // for it costs no round trip. CHARGED all the same: the bytes enter the model's context now,
    // which is what the exploration budget bounds, and it takes a `read` row of its own beside the
    // seed's `refused` one, because the citation check upstream keys on the OUTCOME.
    const withheld = this.withheld[key]
    if (withheld !== undefined) {
      const answer = this.charge(key, withheld)
      // Dropped only once it is SERVED: a charge refused for an exhausted budget must leave the
      // body where it is, so a later call with room can still answer it without a second fetch.
      if (answer.outcome === 'read') delete this.withheld[key]
      return answer
    }
    return request.kind === 'list'
      ? await this.exploreList(reader, path, key)
      : await this.exploreRead(reader, path, key)
  }

  private async exploreList(
    reader: SideReader,
    path: string,
    key: string,
  ): Promise<MonorepoExplorationAnswer> {
    const result = await reader.list(path)
    if ('failed' in result) return this.fail(key, result.failed)
    if (result.entries.length === 0) {
      this.record({
        path: key,
        origin: 'model',
        outcome: 'absent',
        chars: 0,
        note: 'no such directory, or it is empty',
      })
      return { outcome: 'absent', body: '', note: 'no such directory, or it is empty', key: null }
    }
    return this.charge(key, renderListing(result.entries, this.limits.maxFileChars))
  }

  private async exploreRead(
    reader: SideReader,
    path: string,
    key: string,
  ): Promise<MonorepoExplorationAnswer> {
    const result = await reader.read(path)
    if ('failed' in result) return this.fail(key, result.failed)
    if (result.content === null) {
      this.record({ path: key, origin: 'model', outcome: 'absent', chars: 0, note: 'no such file' })
      return { outcome: 'absent', body: '', note: 'no such file in this repository', key: null }
    }
    return this.charge(key, clip(this.scrub(result.content), this.limits.maxFileChars))
  }

  /** Spend a model read's characters, or refuse it because the content budget is gone. */
  private charge(key: string, body: string): MonorepoExplorationAnswer {
    const remaining = this.limits.maxExplorationChars - this.explorationChars
    if (body.length > remaining) {
      this.exhausted = 'chars'
      const note =
        `the exploration content budget is spent (${this.limits.maxExplorationChars} characters). ` +
        `Answer from what you have already seen, and say in the rationale which areas you could ` +
        `not check`
      this.record({ path: key, origin: 'model', outcome: 'refused', chars: 0, note })
      return { outcome: 'refused', body: '', note, key: null }
    }
    this.explorationChars += body.length
    this.bodies[key] = body
    this.record({ path: key, origin: 'model', outcome: 'read', chars: body.length, note: null })
    return { outcome: 'read', body, note: null, key }
  }

  /** A provider failure on a model read: recorded, and stated to the model as UNKNOWN. */
  private fail(key: string, cause: string): MonorepoExplorationAnswer {
    this.log?.warn('monorepo survey: model-requested read failed', { key, err: cause })
    this.record({ path: key, origin: 'model', outcome: 'unreadable', chars: 0, note: cause })
    return {
      outcome: 'unreadable',
      body: '',
      note: `that read failed (${cause}); treat what it would have said as UNKNOWN, not as absent`,
      key: null,
    }
  }

  /** A read the platform declines: recorded on the transcript, and the reason given to the model. */
  private refuse(request: MonorepoExplorationRequest, note: string): MonorepoExplorationAnswer {
    this.record({
      path: keyFor(request.side, request.kind, request.path.slice(0, 200) || '.'),
      origin: 'model',
      outcome: 'refused',
      chars: 0,
      note,
    })
    return { outcome: 'refused', body: '', note, key: null }
  }

  /** Whether a path is the new service's own directory or something under it. */
  private isInsideTarget(path: string): boolean {
    const target = this.request.directory.replace(/\/+$/, '')
    return target !== '' && (path === target || path.startsWith(`${target}/`))
  }

  /**
   * Scrub at READ time, so every body is scrubbed once and nothing can reach a model through a
   * path that forgot to. A prompt built from an unscrubbed body is strictly more exposed than the
   * transcript, and the exploration half has no compose step a caller could scrub at.
   */
  private scrub(body: string): string {
    return redactSecrets(body) ?? ''
  }

  /**
   * Append to the transcript, up to the cap.
   *
   * Past {@link MAX_ADOPTION_READS} the entry is COUNTED and not recorded: one model turn can emit
   * any number of tool calls, so the array needs a bound the call budget does not give it, and
   * that count is what states the truncation to the reviewer. The gap between `calls` and the
   * array's length cannot: the seed adds rows without adding calls, and a call answered from what
   * was already read adds a call without a row.
   */
  private record(read: AdoptionRead): void {
    if (this.reads.length >= MAX_ADOPTION_READS) {
      this.recordsDropped += 1
      return
    }
    this.reads.push(read)
  }
}

/**
 * Open a survey of both sides of a monorepo bootstrap and read its opening context.
 *
 * Two reads make up the monorepo half and the second is the one that matters most: the root
 * config says what the repository declares, and the sibling services beside the target say what a
 * service in this repository actually looks like, which is the thing a new service has to match
 * and the thing no root file states. Everything past that is the model's to ask for.
 */
export async function surveyMonorepo(
  request: MonorepoSurveyRequest,
): Promise<MonorepoSurveySession> {
  const session = new MonorepoSurveySession(request)
  await session.seed()
  return session
}
