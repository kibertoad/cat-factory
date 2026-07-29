import { parse as parseYaml } from 'yaml'
import type { EcosystemDetection, EcosystemDetector, RepoView } from './validation-detection.js'
import { check, ecosystem } from './validation-detection.js'

// ---------------------------------------------------------------------------
// PRE-PR VALIDATION AUTODETECTION — the per-ecosystem rules.
//
// One detector per ecosystem, each a pure `RepoView → EcosystemDetection | null`. The
// composition, ordering and label rules live in `validation-detection.ts`; this file holds
// only the knowledge of what each ecosystem's conventions ARE, so adding an ecosystem is a
// new function plus an entry in {@link LANGUAGE_DETECTORS} (and a `ValidationEcosystem`
// member in `@cat-factory/contracts`, whose picklist the typecheck holds you to).
//
// Every rule follows the governing principle stated in `validation-detection.ts`: suggest
// what the repo DECLARES (a script, a target, a checked-in tool config) or what is the
// ecosystem's canonical, non-opinionated verification. Opinionated gates the repo has never
// run are gated on their own config file.
// ---------------------------------------------------------------------------

/**
 * The root manifests whose CONTENT the reader fetches (everything else is presence-only).
 * Bounded on purpose: the reader turns this into one file read per entry that actually
 * exists, so a new entry here is a new round trip on every detection.
 */
export const VALIDATION_DETECTION_CONTENT_FILES: readonly string[] = [
  'package.json',
  'composer.json',
  'pyproject.toml',
  'Makefile',
  'makefile',
  'GNUmakefile',
  'justfile',
  'Justfile',
  '.justfile',
  'Taskfile.yml',
  'Taskfile.yaml',
]

// ---- shared helpers -------------------------------------------------------

/**
 * Whether a TOML document declares `[section]` or any `[section.sub]` beneath it. Kernel
 * carries no TOML parser and a full one would be a dependency bought for four `pyproject`
 * lookups; a section header is anchored and unambiguous enough to match directly. A header
 * inside a multi-line string would be a false positive — harmless here, since the worst
 * outcome is one extra suggested check the operator deletes.
 */
function hasTomlSection(content: string | undefined, section: string): boolean {
  if (!content) return false
  const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(String.raw`^\s*\[\s*${escaped}(\.[^\]]*)?\s*\]`, 'm').test(content)
}

/** A manifest's `scripts` map, keeping only the string entries (npm and composer share the shape). */
function scriptsOf(manifest: Record<string, unknown> | undefined): Record<string, string> {
  const raw = manifest?.scripts
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string') out[name] = value
  }
  return out
}

/**
 * The first declared script from `candidates`, skipping `npm init`'s placeholder `test`
 * (`echo "Error: no test specified" && exit 1`) — suggesting it would produce a check that
 * fails every run of a repo that simply has no tests.
 */
function firstScript(
  scripts: Record<string, string>,
  candidates: readonly string[],
): string | null {
  for (const name of candidates) {
    const body = scripts[name]
    if (body === undefined) continue
    if (/no test specified/i.test(body)) continue
    return name
  }
  return null
}

// ---- Node -----------------------------------------------------------------

/**
 * Script names per role, most-specific first.
 *
 * The `test` order is deliberate: a CI/run-once variant is preferred over bare `test`,
 * because a `test` script that is plain `vitest`/`jest --watch` never exits and would be
 * killed by the per-command watchdog 15 minutes later — a repo that has both almost always
 * means the explicit one. A repo with only a watch-mode `test` still gets it suggested; the
 * operator sees the command before saving.
 */
const NODE_SCRIPTS = {
  format: ['format:check', 'fmt:check', 'format-check', 'check-format', 'prettier:check'],
  lint: ['lint', 'lint:ci', 'eslint', 'oxlint', 'biome:check'],
  typecheck: ['typecheck', 'type-check', 'tsc', 'types'],
  build: ['build', 'compile'],
  test: ['test:ci', 'test:run', 'test', 'test:unit', 'tests'],
} as const

interface NodePackageManager {
  install: string
  run: (script: string) => string
}

/**
 * Which package manager the repo uses: its own `packageManager` field (corepack's
 * declaration, the strongest evidence) first, then the lockfile, then npm. The install
 * command asks for a REPRODUCIBLE install when a lockfile backs it, because that is what a
 * verification checkout wants — and degrades to a plain install when there is none, rather
 * than suggesting a command that errors out on a lockfile-less repo.
 */
function nodePackageManager(
  view: RepoView,
  manifest: Record<string, unknown> | undefined,
): NodePackageManager {
  const declared = typeof manifest?.packageManager === 'string' ? manifest.packageManager : ''
  const named = declared.split('@')[0]?.trim().toLowerCase()

  const isPnpm = named === 'pnpm' || (!named && view.has('pnpm-lock.yaml'))
  if (isPnpm) {
    return {
      install: view.has('pnpm-lock.yaml') ? 'pnpm install --frozen-lockfile' : 'pnpm install',
      run: (s) => `pnpm run ${s}`,
    }
  }

  const isYarn = named === 'yarn' || (!named && view.has('yarn.lock'))
  if (isYarn) {
    // `--immutable` is Yarn 2+; Yarn 1 spells the same thing `--frozen-lockfile` and errors
    // on the modern flag. `.yarnrc.yml` is the berry marker (Yarn 1 uses `.yarnrc`).
    const berry = view.has('.yarnrc.yml') || /^yarn@[2-9]/.test(declared)
    if (!view.has('yarn.lock')) return { install: 'yarn install', run: (s) => `yarn run ${s}` }
    return {
      install: berry ? 'yarn install --immutable' : 'yarn install --frozen-lockfile',
      run: (s) => `yarn run ${s}`,
    }
  }

  const isBun = named === 'bun' || (!named && view.hasAny('bun.lockb', 'bun.lock'))
  if (isBun) {
    return {
      install: view.hasAny('bun.lockb', 'bun.lock')
        ? 'bun install --frozen-lockfile'
        : 'bun install',
      run: (s) => `bun run ${s}`,
    }
  }

  return {
    install: view.has('package-lock.json') ? 'npm ci' : 'npm install',
    run: (s) => `npm run ${s}`,
  }
}

/**
 * Node: the scripts the repo declares ARE the evidence. Nothing is invented — a repo with
 * no `lint` script gets no lint check, because guessing `npx eslint .` on a project that
 * never configured eslint produces a check that fails for reasons no agent can fix.
 */
export function detectNode(view: RepoView): EcosystemDetection | null {
  if (!view.has('package.json')) return null
  const manifest = view.json('package.json')
  const scripts = scriptsOf(manifest)
  const pm = nodePackageManager(view, manifest)
  const script = (role: keyof typeof NODE_SCRIPTS) => {
    const name = firstScript(scripts, NODE_SCRIPTS[role])
    return name ? pm.run(name) : null
  }

  return ecosystem('node', [
    check('install', 'install', pm.install),
    check('format', 'format', script('format')),
    check('lint', 'lint', script('lint')),
    check('typecheck', 'typecheck', script('typecheck')),
    check('build', 'build', script('build')),
    check('test', 'test', script('test')),
  ])
}

// ---- Python ---------------------------------------------------------------

interface PythonToolchain {
  install: string | null
  /** Prefix that runs a tool inside the project env (`uv run `), or '' for a bare call. */
  prefix: string
}

/** The dependency manager, resolved from its lockfile or its `pyproject` section. */
function pythonToolchain(view: RepoView, pyproject: string | undefined): PythonToolchain {
  if (view.has('uv.lock') || hasTomlSection(pyproject, 'tool.uv')) {
    return { install: view.has('uv.lock') ? 'uv sync --frozen' : 'uv sync', prefix: 'uv run ' }
  }
  if (view.has('poetry.lock') || hasTomlSection(pyproject, 'tool.poetry')) {
    return { install: 'poetry install --no-interaction', prefix: 'poetry run ' }
  }
  if (view.has('pdm.lock') || hasTomlSection(pyproject, 'tool.pdm')) {
    return { install: 'pdm install', prefix: 'pdm run ' }
  }
  if (view.has('Pipfile')) return { install: 'pipenv install --dev', prefix: 'pipenv run ' }
  if (view.has('requirements.txt')) {
    return { install: 'pip install -r requirements.txt', prefix: '' }
  }
  if (view.hasAny('pyproject.toml', 'setup.py')) return { install: 'pip install -e .', prefix: '' }
  return { install: null, prefix: '' }
}

/** Whether the repo carries enough evidence that pytest is its runner. */
function usesPytest(view: RepoView, pyproject: string | undefined): boolean {
  return (
    hasTomlSection(pyproject, 'tool.pytest') ||
    view.hasAny('pytest.ini', 'conftest.py') ||
    view.hasDir('tests') ||
    view.hasDir('test')
  )
}

export function detectPython(view: RepoView): EcosystemDetection | null {
  if (
    !view.hasAny(
      'pyproject.toml',
      'requirements.txt',
      'setup.py',
      'setup.cfg',
      'tox.ini',
      'Pipfile',
    )
  ) {
    return null
  }
  const pyproject = view.read('pyproject.toml')
  const { install, prefix } = pythonToolchain(view, pyproject)

  const ruff = hasTomlSection(pyproject, 'tool.ruff') || view.hasAny('ruff.toml', '.ruff.toml')
  const black = hasTomlSection(pyproject, 'tool.black')
  const mypy = hasTomlSection(pyproject, 'tool.mypy') || view.hasAny('mypy.ini', '.mypy.ini')
  const pyright = hasTomlSection(pyproject, 'tool.pyright') || view.has('pyrightconfig.json')

  // `tox` orchestrates its own envs and typically runs the suite itself, so suggesting it
  // ALONGSIDE a bare pytest would run everything twice.
  const test = view.has('tox.ini') ? 'tox' : usesPytest(view, pyproject) ? `${prefix}pytest` : null

  return ecosystem('python', [
    check('install', 'install', install),
    check(
      'format',
      'format',
      ruff ? `${prefix}ruff format --check .` : black ? `${prefix}black --check .` : null,
    ),
    check('lint', 'lint', ruff ? `${prefix}ruff check .` : null),
    check('typecheck', 'typecheck', mypy ? `${prefix}mypy .` : pyright ? `${prefix}pyright` : null),
    check('test', 'test', test),
  ])
}

// ---- Go / Rust ------------------------------------------------------------

export function detectGo(view: RepoView): EcosystemDetection | null {
  if (!view.has('go.mod')) return null
  const golangci = view.hasAny(
    '.golangci.yml',
    '.golangci.yaml',
    '.golangci.toml',
    '.golangci.json',
  )
  return ecosystem('go', [
    // `go vet` ships with the toolchain and is deliberately low-false-positive, so it is
    // safe to suggest unconditionally; `golangci-lint` is opinionated and only suggested
    // when the repo checked in its config (and therefore already runs it).
    check('lint', 'lint', golangci ? 'golangci-lint run ./...' : 'go vet ./...'),
    check('build', 'build', 'go build ./...'),
    check('test', 'test', 'go test ./...'),
  ])
}

export function detectRust(view: RepoView): EcosystemDetection | null {
  if (!view.has('Cargo.toml')) return null
  const rustfmt = view.hasAny('rustfmt.toml', '.rustfmt.toml')
  const clippy = view.hasAny('clippy.toml', '.clippy.toml')
  return ecosystem('rust', [
    // Both gates are all-or-nothing on a codebase that never ran them, so each needs the
    // repo's own config as evidence. `cargo test` compiles the crate, so no separate build.
    check('format', 'format', rustfmt ? 'cargo fmt --all -- --check' : null),
    check('lint', 'lint', clippy ? 'cargo clippy --all-targets -- -D warnings' : null),
    check('test', 'test', view.has('Cargo.lock') ? 'cargo test --locked' : 'cargo test'),
  ])
}

// ---- JVM / .NET -----------------------------------------------------------

export function detectMaven(view: RepoView): EcosystemDetection | null {
  if (!view.has('pom.xml')) return null
  // The wrapper pins the Maven version the repo was built against; prefer it when present.
  const mvn = view.has('mvnw') ? './mvnw' : 'mvn'
  // `verify` is the lifecycle phase that compiles, tests and runs the configured checks —
  // one command covering what separate build/test suggestions would duplicate.
  return ecosystem('maven', [check('test', 'verify', `${mvn} -B --no-transfer-progress verify`)])
}

export function detectGradle(view: RepoView): EcosystemDetection | null {
  if (!view.hasAny('build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts')) {
    return null
  }
  const gradle = view.has('gradlew') ? './gradlew' : 'gradle'
  // Gradle's `build` task depends on `check` (which runs the tests), so it is the single
  // verification command; `--no-daemon` keeps the container from leaving a daemon behind.
  return ecosystem('gradle', [check('build', 'build', `${gradle} --no-daemon build`)])
}

export function detectDotnet(view: RepoView): EcosystemDetection | null {
  const hasProject = ['.sln', '.slnx', '.csproj', '.fsproj', '.vbproj'].some((s) =>
    view.hasFileWithSuffix(s),
  )
  if (!hasProject) return null
  // `dotnet test` restores and builds before running the suite, so a separate build check
  // would compile the solution twice for no extra signal.
  return ecosystem('dotnet', [
    check('install', 'restore', 'dotnet restore'),
    check('test', 'test', 'dotnet test --nologo'),
  ])
}

// ---- Ruby / PHP / Elixir --------------------------------------------------

export function detectRuby(view: RepoView): EcosystemDetection | null {
  if (!view.has('Gemfile')) return null
  const rubocop = view.hasAny('.rubocop.yml', '.rubocop.yaml')
  const rspec = view.has('.rspec') || view.hasDir('spec')
  const rake = view.has('Rakefile') && view.hasDir('test')
  return ecosystem('ruby', [
    check('install', 'install', 'bundle install'),
    check('lint', 'lint', rubocop ? 'bundle exec rubocop' : null),
    check('test', 'test', rspec ? 'bundle exec rspec' : rake ? 'bundle exec rake test' : null),
  ])
}

/** Composer script names per role, most-specific first. */
const COMPOSER_SCRIPTS = {
  lint: ['lint', 'cs-check', 'phpcs', 'check-style', 'cs'],
  typecheck: ['phpstan', 'psalm', 'analyse', 'analyze', 'static-analysis'],
  test: ['test', 'tests', 'phpunit'],
} as const

export function detectPhp(view: RepoView): EcosystemDetection | null {
  if (!view.has('composer.json')) return null
  const scripts = scriptsOf(view.json('composer.json'))
  const script = (role: keyof typeof COMPOSER_SCRIPTS) => {
    const name = firstScript(scripts, COMPOSER_SCRIPTS[role])
    return name ? `composer run-script ${name}` : null
  }
  // A repo with a phpunit config but no composer script still has one obvious command.
  const test =
    script('test') ?? (view.hasAny('phpunit.xml', 'phpunit.xml.dist') ? 'vendor/bin/phpunit' : null)
  return ecosystem('php', [
    check('install', 'install', 'composer install --no-interaction --prefer-dist'),
    check('lint', 'lint', script('lint')),
    check('typecheck', 'static analysis', script('typecheck')),
    check('test', 'test', test),
  ])
}

export function detectElixir(view: RepoView): EcosystemDetection | null {
  if (!view.has('mix.exs')) return null
  return ecosystem('elixir', [
    check('install', 'deps', 'mix deps.get'),
    check('format', 'format', view.has('.formatter.exs') ? 'mix format --check-formatted' : null),
    check('lint', 'lint', view.has('.credo.exs') ? 'mix credo --strict' : null),
    check('test', 'test', 'mix test'),
  ])
}

// ---- Task runners (the fallback tier) -------------------------------------

/**
 * Target/recipe names per role. `ci`, `check` and `verify` are UMBRELLA names — a repo that
 * declares one means it to run everything, so it is suggested ALONE (see
 * {@link fromTaskRunner}) rather than beside the individual targets it already invokes.
 */
const TASK_TARGETS = {
  umbrella: ['ci', 'check', 'verify', 'validate'],
  format: ['format-check', 'fmt-check', 'format', 'fmt'],
  lint: ['lint'],
  typecheck: ['typecheck', 'type-check'],
  build: ['build'],
  test: ['test'],
} as const

/**
 * Shape a task-runner ecosystem from the target names a manifest declares. Shared by make,
 * just and task because the three differ only in how their names are extracted.
 */
function fromTaskRunner(
  id: 'make' | 'just' | 'task',
  invoke: (target: string) => string,
  declared: Set<string>,
): EcosystemDetection | null {
  const pick = (role: keyof typeof TASK_TARGETS) =>
    TASK_TARGETS[role].find((t) => declared.has(t)) ?? null
  const run = (role: keyof typeof TASK_TARGETS) => {
    const target = pick(role)
    return target ? invoke(target) : null
  }

  const umbrella = pick('umbrella')
  if (umbrella) return ecosystem(id, [check('test', umbrella, invoke(umbrella))])

  return ecosystem(id, [
    check('format', 'format', run('format')),
    check('lint', 'lint', run('lint')),
    check('typecheck', 'typecheck', run('typecheck')),
    check('build', 'build', run('build')),
    check('test', 'test', run('test')),
  ])
}

/**
 * Make target names: a line-leading name followed by `:` (but not `:=`, a variable
 * assignment). `.PHONY` and friends are excluded by requiring an alphanumeric first
 * character, and a recipe body is excluded by anchoring at column 0 (recipe lines are
 * tab-indented by definition).
 */
function makeTargets(content: string): Set<string> {
  const names = new Set<string>()
  for (const match of content.matchAll(/^([A-Za-z0-9][A-Za-z0-9._/-]*)\s*:(?!=)/gm)) {
    if (match[1]) names.add(match[1].toLowerCase())
  }
  return names
}

/** Just recipe names: a line-leading name, optional parameters, then `:`. */
function justRecipes(content: string): Set<string> {
  const names = new Set<string>()
  for (const match of content.matchAll(/^@?([A-Za-z0-9][A-Za-z0-9_-]*)[^:\n]*:(?!=)/gm)) {
    if (match[1]) names.add(match[1].toLowerCase())
  }
  return names
}

/**
 * Task (Taskfile.dev) task names — the keys of the top-level `tasks:` map. Parsed with the
 * real YAML parser rather than a regex: a Taskfile's task bodies are themselves maps with
 * nested keys, so an indentation-based match would pick up `cmds`/`deps` as task names.
 */
function taskfileTasks(content: string): Set<string> {
  const names = new Set<string>()
  let doc: unknown
  try {
    doc = parseYaml(content)
  } catch {
    // silent-catch-ok: an unparseable Taskfile is a detection MISS — the operator still
    // gets every other ecosystem's suggestions rather than an error about their YAML.
    return names
  }
  const tasks = (doc as { tasks?: unknown } | null)?.tasks
  if (typeof tasks !== 'object' || tasks === null || Array.isArray(tasks)) return names
  for (const name of Object.keys(tasks as Record<string, unknown>)) names.add(name.toLowerCase())
  return names
}

export function detectMake(view: RepoView): EcosystemDetection | null {
  const content = view.readAny('Makefile', 'makefile', 'GNUmakefile')
  if (content === undefined) return null
  return fromTaskRunner('make', (t) => `make ${t}`, makeTargets(content))
}

export function detectJust(view: RepoView): EcosystemDetection | null {
  const content = view.readAny('justfile', 'Justfile', '.justfile')
  if (content === undefined) return null
  return fromTaskRunner('just', (t) => `just ${t}`, justRecipes(content))
}

export function detectTask(view: RepoView): EcosystemDetection | null {
  const content = view.readAny('Taskfile.yml', 'Taskfile.yaml')
  if (content === undefined) return null
  return fromTaskRunner('task', (t) => `task ${t}`, taskfileTasks(content))
}

// ---- registries -----------------------------------------------------------

/** Language ecosystems, in the order their suggestions are presented. */
export const LANGUAGE_DETECTORS: readonly EcosystemDetector[] = [
  detectNode,
  detectPython,
  detectGo,
  detectRust,
  detectMaven,
  detectGradle,
  detectDotnet,
  detectRuby,
  detectPhp,
  detectElixir,
]

/** Generic task runners — consulted only when no language ecosystem matched. */
export const TASK_RUNNER_DETECTORS: readonly EcosystemDetector[] = [
  detectMake,
  detectJust,
  detectTask,
]

/**
 * The registries as `detectValidationChecks` takes them. Passed explicitly rather than
 * defaulted inside the composer, which would make `validation-detection.ts` import this
 * module and this module import it back — and which would also hide the seam a deployment
 * would extend to teach the detector its own house convention.
 */
export const DEFAULT_VALIDATION_DETECTORS = {
  language: LANGUAGE_DETECTORS,
  taskRunner: TASK_RUNNER_DETECTORS,
} as const
