import type {
  AdoptionExploration,
  AdoptionRead,
  AdoptionReadOrigin,
  AdoptionSurvey,
} from '@cat-factory/contracts'
import { MAX_ADOPTION_READS } from '@cat-factory/contracts'
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
// context (each side's root listing and the convention files it really holds, the CI directory,
// and the listing of every sibling that looks like a service), because there is no reason to
// spend model calls rediscovering `package.json` and it keeps the cheap case cheap. The MODEL
// then widens it: it asks for the CI workflow that will actually gate the pull request, follows
// a dependency into the shared package that says what adopting it entails, and opens a second
// and a third sibling when the first two disagree. None of that is enumerable in advance, which
// is why the previous declared list decided what the survey could not see before it looked.
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
 * The CI directory the seed LISTS (never reads) when the root holds its parent.
 *
 * Listing rather than reading is the correction the tool loop makes possible: a monorepo with
 * reusable workflows plus thirty per-service ones used to contribute an arbitrary two, and what
 * a new directory is actually REQUIRED to satisfy (a path filter, a required check) was likely
 * in one of the twenty-eight nobody read. The listing is the menu; the model picks off it.
 */
const CI_DIRECTORY = '.github/workflows'
/** The root entry whose presence makes {@link CI_DIRECTORY} worth listing. */
const CI_ROOT_ENTRY = '.github'

/**
 * How many sibling directories are probed as candidate worked examples.
 *
 * Higher than the old pick-one probe because the seed no longer reads their files: a candidate
 * costs one listing, and offering several is what makes a monorepo whose services DISAGREE
 * representable at all. Dot-entries are excluded outright, and a candidate qualifies only by
 * holding a convention file of its own.
 */
const MAX_SIBLING_CANDIDATES = 6

/** Per-file content cap. A convention is legible from its opening; a lockfile-sized read is not. */
const MAX_FILE_CHARS = 6_000
/** How many root files one side contributes to the opening context, most-conventional first. */
const MAX_ROOT_FILES = 14

/**
 * The opening context's character budget, RESERVED per side.
 *
 * Spent in key order it would not be a bound at all but a handover to whichever side sorts
 * first, and `monorepo:` sorts before `template:` for every key: a large monorepo would spend
 * the whole allowance and the template would land entirely refused, which is exactly the
 * crowding-out this exists to prevent. Each side gets a reserved half, spent in its own priority
 * order, and whatever one side leaves unspent is then offered to the other.
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
 * A repository-relative path the platform is willing to fetch, or the reason it will not.
 *
 * The path is MODEL-AUTHORED and becomes a URL path segment on the VCS contents API, so it is
 * validated for magic rather than only for traversal: a control character or a backslash means
 * the model is guessing at a shell or a Windows path, and answering "not found" would tell it the
 * repository lacks a file it never actually asked for. A refusal is REPORTED (it lands on the
 * transcript and the model is told), never a silent shortening.
 */
export function normalizeSurveyPath(raw: string): { path: string } | { refused: string } {
  const trimmed = raw.trim().replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '')
  if (trimmed.length > 400) return { refused: 'the path is too long to be a repository path' }
  if (trimmed.includes('\\') || [...trimmed].some((ch) => ch.charCodeAt(0) < 0x20)) {
    return { refused: 'the path contains characters that are not part of a repository path' }
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

/** Render a directory's entries as the body a decision can cite for layout. */
function renderListing(entries: { name: string; type: string }[]): string {
  return entries
    .map((entry) => `${entry.name}${entry.type === 'dir' ? '/' : ''}`)
    .sort()
    .join('\n')
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
  private readonly seedKeys = new Set<string>()
  private siblings: string[] = []
  private calls = 0
  private explorationChars = 0
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
   * The one caller is a reference template the workspace has not LINKED: unreadable from here
   * even though the apply phase's container can still clone it. "The template ships nothing for
   * this area" and "nobody looked at the template" lead a reviewer to opposite conclusions.
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
    const root = await this.listInto(reader, '', 'seed', candidates)
    if (root) {
      await this.takeConventionFiles(reader, '', root, candidates)
      if (root.some((entry) => entry.name === CI_ROOT_ENTRY)) {
        await this.listInto(reader, CI_DIRECTORY, 'seed', candidates)
      }
    }
    const parent = parentDirectoryOf(this.request.directory)
    // Re-uses the root listing for a root-level target rather than asking for it twice. The
    // parent's own listing contributes no citable entry (the empty candidate sink): it is the
    // MENU the sibling probe reads, and each qualifying sibling's listing carries the layout
    // evidence. A failure to list it is still recorded, because "no siblings" and "could not see
    // whether there are siblings" are opposite facts.
    const siblingEntries = parent === '' ? root : await this.listInto(reader, parent, 'seed', [])
    const siblings = await this.probeSiblings(reader, siblingEntries, candidates)
    return { candidates, siblings }
  }

  private async seedTemplate(reader: SideReader): Promise<SeedHarvest> {
    const candidates: SeedCandidate[] = []
    const root = await this.listInto(reader, '', 'seed', candidates)
    if (root) await this.takeConventionFiles(reader, '', root, candidates)
    return { candidates, siblings: [] }
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
    origin: AdoptionReadOrigin,
    candidates: SeedCandidate[],
  ): Promise<{ name: string; type: string; path: string }[] | null> {
    const key = keyFor(reader.prefix, 'list', path)
    const result = await reader.list(path)
    if ('failed' in result) {
      this.log?.warn('monorepo survey: directory listing failed', {
        side: reader.prefix,
        path,
        err: result.failed,
      })
      this.record({ path: key, origin, outcome: 'unreadable', chars: 0, note: result.failed })
      return null
    }
    if (result.entries.length === 0) {
      this.record({
        path: key,
        origin,
        outcome: 'absent',
        chars: 0,
        note: 'the directory is empty or does not exist',
      })
      return result.entries
    }
    candidates.push({ key, body: renderListing(result.entries) })
    return result.entries
  }

  /** Read the convention files a listed directory actually holds, capped and in priority order. */
  private async takeConventionFiles(
    reader: SideReader,
    dir: string,
    entries: { name: string; type: string }[],
    candidates: SeedCandidate[],
  ): Promise<void> {
    const present = new Set(
      entries.filter((entry) => entry.type === 'file').map((entry) => entry.name),
    )
    const wanted = CONVENTION_FILES.filter((name) => present.has(name)).slice(0, MAX_ROOT_FILES)
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
   * Excludes the target itself, every dot-entry, and the CI folder: a directory that says nothing
   * about how a service here is built is worse than no example, because "no sibling" is a fact
   * the plan REPORTS while a bad sibling is one it asserts.
   */
  private async probeSiblings(
    reader: SideReader,
    entries: { name: string; type: string; path: string }[] | null,
    candidates: SeedCandidate[],
  ): Promise<string[]> {
    if (!entries) return []
    const target = this.request.directory
    const qualifying: string[] = []
    const probes = entries
      .filter(
        (entry) =>
          entry.type === 'dir' &&
          entry.path !== target &&
          !entry.name.startsWith('.') &&
          entry.path !== CI_DIRECTORY,
      )
      .map((entry) => entry.path)
      .sort()
      .slice(0, MAX_SIBLING_CANDIDATES)
    for (const candidate of probes) {
      const own = await reader.list(candidate)
      if ('failed' in own) continue
      const names = new Set(own.entries.filter((e) => e.type === 'file').map((e) => e.name))
      if (!CONVENTION_FILES.some((name) => names.has(name))) continue
      qualifying.push(candidate)
      candidates.push({
        key: keyFor(reader.prefix, 'list', candidate),
        body: renderListing(own.entries),
      })
    }
    return qualifying
  }

  /**
   * Apply the per-side reservation to everything the seed fetched, and record the result.
   *
   * A body that does not fit is recorded `refused` rather than dropped, for the same reason the
   * survey reports what it could not read: the model must not treat a file it was never shown as
   * a file that does not exist, and the reviewer sees the same list. Whatever an earlier side
   * leaves unspent carries forward, so the reservation is a floor rather than a ceiling.
   */
  private commitSeed(harvests: SeedHarvest[]): void {
    const share = Math.floor(this.limits.maxSeedChars / Math.max(1, harvests.length))
    let spare = this.limits.maxSeedChars - share * harvests.length
    for (const harvest of harvests) {
      this.siblings = [...this.siblings, ...harvest.siblings]
      let budget = share + spare
      for (const candidate of harvest.candidates) {
        if (candidate.body.length > budget) {
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
    return this.charge(key, renderListing(result.entries))
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
   * Past {@link MAX_ADOPTION_READS} the entry is counted but not recorded: one model turn can
   * emit any number of tool calls, so the array needs a bound the call budget does not give it.
   * `exploration.calls` carries the true total, which is what states the truncation.
   */
  private record(read: AdoptionRead): void {
    if (this.reads.length >= MAX_ADOPTION_READS) return
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
