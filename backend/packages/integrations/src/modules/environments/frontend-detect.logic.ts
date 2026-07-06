import type {
  FrontendBackendBinding,
  FrontendConfig,
  FrontendConfigRecommendation,
  FrontendDetectionNote,
  FrontendPackageManager,
} from '@cat-factory/contracts'
import { RepoReadError } from './repo-read-error.js'

// ---------------------------------------------------------------------------
// Frontend-config AUTO-DETECTION: a deterministic, pure-TS heuristic that proposes a NON-BINDING
// recommended `FrontendConfig` from a frontend repo, read CHECKOUT-FREE over a minimal
// RepoFiles-shaped reader. No LLM, no clone — just targeted file reads +
// package.json/dotenv parsing. The user always confirms/edits; nothing here is applied silently.
// Mirrors the service-provisioning detector (`provision-detect.logic.ts`): high-confidence facts
// (a lockfile ⇒ the package manager) are inferred deterministically; ambiguous ones (which build
// script, which output dir) are proposed at low confidence with a rationale rather than guessed.
// ---------------------------------------------------------------------------

/**
 * The narrow slice of {@link RepoFiles} the detector needs — a {@link RepoFiles} satisfies it
 * structurally, and a test supplies an in-memory fake. A MISSING path yields `null`, so the
 * heuristics degrade gracefully on partial repos. A genuine read fault (auth/permission revoked,
 * rate limit, transport error) may THROW — the real reader throws on any non-404 status. The
 * {@link Scanner} tolerates that (records it, keeps scanning) so a truly unreadable repo surfaces
 * an actionable error instead of a misleading "not a frontend repo"; see {@link Scanner.readFault}.
 */
export interface FrontendRepoReader {
  getFile(path: string, gitRef?: string): Promise<{ content: string } | null>
}

export interface DetectFrontendConfigOptions {
  /** Frontend subdirectory within the repo (monorepo); absent/'' ⇒ the repo root. */
  directory?: string
  /** Git ref to read at; absent ⇒ the reader's default branch. */
  gitRef?: string
}

// Lockfiles ranked to the package manager they pin, most-preferred first (pnpm > yarn > npm).
const LOCKFILES: { file: string; pm: FrontendPackageManager }[] = [
  { file: 'pnpm-lock.yaml', pm: 'pnpm' },
  { file: 'yarn.lock', pm: 'yarn' },
  { file: 'package-lock.json', pm: 'npm' },
]
// The frozen/CI install command per package manager.
const INSTALL_COMMANDS: Record<FrontendPackageManager, string> = {
  pnpm: 'pnpm install --frozen-lockfile',
  yarn: 'yarn install --frozen-lockfile',
  npm: 'npm ci',
}
// Build-script names to try, in order; the first present one in package.json `scripts` wins.
const BUILD_SCRIPT_CANDIDATES = ['build', 'build:prod', 'generate']
// A script that serves a PRODUCTION preview of the build (⇒ serveMode `command`). `dev` and
// `start` are deliberately excluded — both are dev servers (e.g. `react-scripts start`), not a
// preview of the built app, so proposing them would launch the wrong process for a UI test.
const SERVE_SCRIPT_CANDIDATES = ['preview', 'serve']
// dotenv example files whose KEYS name the frontend's env vars (values are the user's).
const ENV_EXAMPLE_FILES = ['.env.example', '.env.sample', '.env.template', '.env.dist']
// Env-var name SUFFIXES that denote a backend/base URL endpoint (⇒ a backend binding, mock-sourced
// by default). Matched on the URL-ish suffix, NOT a framework prefix: `VITE_`/`NEXT_PUBLIC_`/… also
// front feature flags, analytics IDs, and titles, so keying off the prefix would pull in non-URL
// config (e.g. `VITE_APP_TITLE`, `NEXT_PUBLIC_GA_ID`).
const BACKEND_ENV_PATTERNS = [/_URL$/, /_URI$/, /_ENDPOINT$/, /_API$/]
// The most backend-binding rows we propose (bounds the output + keeps the UI sane).
const MAX_BINDINGS = 12
// Bounds the total reads so a pathological repo can't fan out unboundedly. Reads are intentionally
// SEQUENTIAL (not batched): the budget short-circuit depends on deterministic in-order accounting.
// A real frontend resolves in a handful of reads; the cap only bites on decoy-heavy repos, where
// truncation is surfaced as a note (see `Scanner.exhausted`).
const READ_BUDGET = 60

/** Join + normalize repo-relative path segments, collapsing `.`/`..`. */
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

/** Stateful repo reader with a hard read budget so detection can't fan out without bound. */
class Scanner {
  private reads = 0
  private truncated = false
  private firstFault: string | undefined
  constructor(
    private readonly reader: FrontendRepoReader,
    private readonly gitRef: string | undefined,
  ) {}

  /**
   * True only once a read was ACTUALLY skipped because the budget was hit — so a complete scan
   * that happens to spend exactly the budget doesn't spuriously report itself truncated.
   */
  get exhausted(): boolean {
    return this.truncated
  }

  /**
   * The message of the FIRST genuine read fault the reader threw (auth/permission revoked, rate
   * limit, transport error), else `undefined`. A miss (absent path) is NOT a fault. The caller
   * raises {@link RepoReadError} when nothing was detected AND this is set.
   */
  get readFault(): string | undefined {
    return this.firstFault
  }

  async getFile(path: string): Promise<string | null> {
    if (this.reads >= READ_BUDGET) {
      this.truncated = true
      return null
    }
    this.reads++
    try {
      const file = await this.reader.getFile(path, this.gitRef)
      return file?.content ?? null
    } catch (err) {
      // A genuine read fault (non-404 — the reader turns 404 into null itself). Record it so an
      // all-miss outcome can be reported as "couldn't read" rather than "not a frontend repo".
      if (this.firstFault === undefined) {
        this.firstFault = err instanceof Error ? err.message : String(err)
      }
      return null
    }
  }

  /** True when a file exists (a cheap presence probe that still spends one read). */
  async exists(path: string): Promise<boolean> {
    return (await this.getFile(path)) !== null
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

interface PackageJson {
  scripts: Record<string, string>
  deps: Record<string, string>
}

/** Parse a package.json's `scripts` + merged dependency names (best-effort; never throws). */
function parsePackageJson(content: string): PackageJson | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return null
  }
  const root = asRecord(parsed)
  if (!root) return null
  const scripts: Record<string, string> = {}
  for (const [k, val] of Object.entries(asRecord(root.scripts) ?? {})) {
    if (typeof val === 'string') scripts[k] = val
  }
  const deps: Record<string, string> = {}
  for (const key of ['dependencies', 'devDependencies']) {
    for (const [k, val] of Object.entries(asRecord(root[key]) ?? {})) {
      if (typeof val === 'string') deps[k] = val
    }
  }
  return { scripts, deps }
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

/** A detected framework + its conventional static output directory (+ whether that's ambiguous). */
interface FrameworkGuess {
  name: string
  outputDir: string
  confidence: 'high' | 'low'
  note: string
  /**
   * The package.json script that produces the static {@link outputDir} above, when it differs from
   * the generic `build` (e.g. Nuxt's `.output/public` comes from `generate`, not `build`). Used to
   * keep the proposed build script and output dir consistent.
   */
  staticBuildScript?: string
}

/**
 * Infer the framework (⇒ its build output directory) from the deps + a config-file probe. Vite is
 * the common case (`dist`); Nuxt/Next carry ambiguity (SSR vs static export) surfaced as a note.
 */
async function detectFramework(
  scanner: Scanner,
  root: string,
  pkg: PackageJson | null,
): Promise<FrameworkGuess | null> {
  const deps = pkg?.deps ?? {}
  const has = (name: string) => name in deps
  // Config-file presence disambiguates when a dep list is missing/minimal.
  const anyConfig = async (bases: string[]) => {
    for (const base of bases) {
      for (const ext of ['ts', 'js', 'mjs', 'cjs']) {
        if (await scanner.exists(joinPath(root, `${base}.${ext}`))) return true
      }
    }
    return false
  }

  if (has('nuxt') || (await anyConfig(['nuxt.config']))) {
    return {
      name: 'Nuxt',
      outputDir: '.output/public',
      confidence: 'low',
      staticBuildScript: 'generate',
      note: 'Nuxt detected. For a static (SPA/prerendered) build the output is .output/public, produced by `nuxt generate`; a Nuxt app served via `nuxt preview` uses Command serve mode instead. Verify which your build produces.',
    }
  }
  if (has('next') || (await anyConfig(['next.config']))) {
    return {
      name: 'Next.js',
      outputDir: 'out',
      confidence: 'low',
      note: 'Next.js detected. `out` is the static-export directory (next export/output:export); a non-static Next app builds to .next and must be served via Command mode. Verify which your build produces.',
    }
  }
  if (has('@angular/core')) {
    return {
      name: 'Angular',
      outputDir: 'dist',
      confidence: 'low',
      note: 'Angular detected; the build output is usually dist/<project-name>. Adjust the exact subfolder if your angular.json names one.',
    }
  }
  if (has('react-scripts')) {
    return {
      name: 'Create React App',
      outputDir: 'build',
      confidence: 'high',
      note: 'Create React App builds to build/.',
    }
  }
  if (has('vite') || (await anyConfig(['vite.config']))) {
    return {
      name: 'Vite',
      outputDir: 'dist',
      confidence: 'high',
      note: 'Vite detected ⇒ the build output is dist/.',
    }
  }
  return null
}

/** Build a `detected: false` recommendation (empty config) with one explanatory note. */
function emptyRecommendation(message: string): FrontendConfigRecommendation {
  return {
    detected: false,
    config: { backendBindings: [] },
    notes: [{ field: 'packageManager', confidence: 'low', message }],
  }
}

/**
 * Detect a recommended frontend config for a repo, read CHECKOUT-FREE. Reads are rooted at
 * `options.directory` (the frontend's subdirectory) or the repo root. Every inferred field carries
 * a confidence note; nothing found ⇒ a `detected: false` recommendation with an explanatory note.
 * Never throws / never persists — the SPA prefills a preview the user applies.
 */
export async function detectFrontendConfig(
  reader: FrontendRepoReader,
  options: DetectFrontendConfigOptions = {},
): Promise<FrontendConfigRecommendation> {
  const root = joinPath(options.directory ?? '')
  const scanner = new Scanner(reader, options.gitRef)
  const notes: FrontendDetectionNote[] = []
  const config: FrontendConfig = { backendBindings: [] }

  // 1) Package manager from the lockfile (high confidence when one exists).
  let packageManager: FrontendPackageManager | undefined
  for (const { file, pm } of LOCKFILES) {
    if (await scanner.exists(joinPath(root, file))) {
      packageManager = pm
      config.packageManager = pm
      config.installCommand = INSTALL_COMMANDS[pm]
      notes.push({
        field: 'packageManager',
        confidence: 'high',
        message: `${file} present ⇒ ${pm}. Proposed install command "${INSTALL_COMMANDS[pm]}".`,
      })
      break
    }
  }

  // 2) package.json drives the build/serve scripts + the framework guess.
  const pkgContent = await scanner.getFile(joinPath(root, 'package.json'))
  const pkg = pkgContent ? parsePackageJson(pkgContent) : null
  if (!pkg && !packageManager) {
    // No package.json AND no lockfile. If the reads couldn't actually reach the repo (a genuine
    // fault, not a clean miss), surface that instead of "this doesn't look like a frontend repo".
    if (scanner.readFault) throw new RepoReadError(scanner.readFault)
    // Otherwise it genuinely doesn't look like a frontend repo (at this root).
    return emptyRecommendation(
      root
        ? `No package.json or lockfile was found under "${root}" — check the frontend directory, or configure the fields manually.`
        : 'No package.json or lockfile was found at the repo root — set the frontend directory (for a monorepo) or configure the fields manually.',
    )
  }
  if (!packageManager) {
    notes.push({
      field: 'packageManager',
      confidence: 'low',
      message: 'No lockfile found; defaulting to pnpm. Set the package manager if that is wrong.',
    })
  }

  // 3) Framework guess ⇒ the output dir (+ the script that produces its static output).
  const framework = await detectFramework(scanner, root, pkg)
  if (framework) {
    config.outputDir = framework.outputDir
    notes.push({ field: 'outputDir', confidence: framework.confidence, message: framework.note })
  } else {
    notes.push({
      field: 'outputDir',
      confidence: 'low',
      message:
        'Could not identify the framework; leaving the output directory unset, so the harness default (dist) applies. Set it if your build outputs elsewhere.',
    })
  }

  // 4) Build script from package.json scripts. When the framework names the script that produces
  //    its detected static output (Nuxt ⇒ `generate` ⇒ .output/public), prefer that so the build
  //    script and output dir agree rather than defaulting to a `build` that yields a different dir.
  if (pkg) {
    const preferred =
      framework?.staticBuildScript && framework.staticBuildScript in pkg.scripts
        ? framework.staticBuildScript
        : undefined
    const buildScript = preferred ?? BUILD_SCRIPT_CANDIDATES.find((s) => s in pkg.scripts)
    if (buildScript) {
      config.buildScript = buildScript
      notes.push({
        field: 'buildScript',
        confidence: !preferred && buildScript === 'build' ? 'high' : 'low',
        message: preferred
          ? `Using the "${buildScript}" script — it produces the ${framework?.name} static output (${framework?.outputDir}). Confirm it's the build you want served.`
          : buildScript === 'build'
            ? 'Found a "build" script.'
            : `No "build" script; using "${buildScript}". Confirm it produces the deployable build.`,
      })
    } else {
      notes.push({
        field: 'buildScript',
        confidence: 'low',
        message: 'No build/build:prod/generate script found — set the build script manually.',
      })
    }
  }

  // 5) Serve mode: a production-preview script ⇒ command mode, else the static default.
  if (pkg) {
    const serveScript = SERVE_SCRIPT_CANDIDATES.find((s) => s in pkg.scripts)
    if (serveScript) {
      config.serveMode = 'command'
      config.serveScript = serveScript
      notes.push({
        field: 'serveMode',
        confidence: 'low',
        message: `Found a "${serveScript}" script ⇒ proposing Command serve mode. Static (serving the build output) is usually cheaper for a UI test — switch if the build is fully static.`,
      })
    } else {
      config.serveMode = 'static'
      notes.push({
        field: 'serveMode',
        confidence: 'high',
        message: 'No preview/serve script found ⇒ serving the build output statically.',
      })
    }
  }

  // 6) Backend bindings: env-var NAMES from the dotenv examples + Vite's `import.meta.env` usage
  //    aren't scanned (too broad) — the dotenv examples are the reliable, bounded source.
  const envNames = new Set<string>()
  for (const file of ENV_EXAMPLE_FILES) {
    const content = await scanner.getFile(joinPath(root, file))
    if (!content) continue
    for (const key of parseEnvExampleKeys(content)) {
      if (BACKEND_ENV_PATTERNS.some((re) => re.test(key))) envNames.add(key)
    }
  }
  if (envNames.size > 0) {
    const bindings: FrontendBackendBinding[] = [...envNames]
      .slice(0, MAX_BINDINGS)
      .map((envVar) => ({ envVar, source: { kind: 'mock' } }))
    config.backendBindings = bindings
    notes.push({
      field: 'backendBindings',
      confidence: 'low',
      message: `Found ${bindings.length} backend URL env var(s) in a .env example, added as mock bindings. Point any at a service frame (the service under test).${envNames.size > bindings.length ? ` ${envNames.size - bindings.length} more were omitted.` : ''}`,
    })
  }

  if (scanner.exhausted) {
    notes.push({
      field: 'packageManager',
      confidence: 'low',
      message:
        'The repository scan was truncated (read budget reached); some fields may be incomplete.',
    })
  }

  return { detected: true, config, notes }
}
