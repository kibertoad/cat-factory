import type { ChangeClass, MergeClassRule, MergeClassRules } from '@cat-factory/contracts'

// ---------------------------------------------------------------------------
// Pure, DETERMINISTIC change classification: given the paths a pull request
// changed, decide WHAT KIND of change it is. Lives in kernel (pure logic, no
// ports) so both the engine's merge policy and the track-record service read the
// same rules, and so a gate/preset package never has to depend on orchestration.
//
// Deliberately path-based, not agent-derived: this feeds a POLICY gate (a preset's
// per-class rule can auto-merge without consulting the merger's scores at all), so
// it must be reproducible from the diff alone, need no container/harness change,
// and be identical for a GitHub or a GitLab deployment.
//
// Full design + the rationale for the precedence rule:
// `docs/initiatives/merge-track-record.md`.
// ---------------------------------------------------------------------------

/**
 * Risk rank per class — HIGHER means riskier, and a mixed diff resolves to the highest rank
 * present. That precedence is what makes a per-class rule safe by construction: "always
 * auto-merge `dependency`" can only fire on a diff that contains nothing riskier than a
 * dependency change, because a single touched source file lifts the whole diff to `source`.
 *
 * `schema` outranks `source` because a migration is effectively irreversible once applied.
 * `unknown` sits below everything at -1 and is never produced by a file match — it means the
 * changed-file list itself was unavailable.
 */
export const CHANGE_CLASS_RANK: Record<ChangeClass, number> = {
  unknown: -1,
  docs: 0,
  test: 1,
  dependency: 2,
  config: 3,
  source: 4,
  schema: 5,
}

/** Case-insensitive basename of a repo-relative path. */
function basenameOf(path: string): string {
  const normalized = path.replaceAll('\\', '/')
  const lastSlash = normalized.lastIndexOf('/')
  return (lastSlash === -1 ? normalized : normalized.slice(lastSlash + 1)).toLowerCase()
}

/** Whether any path segment (directory OR file) equals one of `names`. */
function hasSegment(lowerPath: string, names: readonly string[]): boolean {
  const segments = lowerPath.split('/')
  return names.some((name) => segments.includes(name))
}

/** Dependency manifests + lockfiles across the ecosystems we plausibly meet. */
const DEPENDENCY_BASENAMES: readonly string[] = [
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'npm-shrinkwrap.json',
  'cargo.toml',
  'cargo.lock',
  'go.mod',
  'go.sum',
  'requirements.txt',
  'requirements-dev.txt',
  'poetry.lock',
  'pyproject.toml',
  'pipfile',
  'pipfile.lock',
  'uv.lock',
  'gemfile',
  'gemfile.lock',
  'composer.json',
  'composer.lock',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'gradle.lockfile',
  'mix.lock',
]

/** Documentation + user-facing copy extensions. */
const DOC_EXTENSIONS: readonly string[] = ['.md', '.mdx', '.markdown', '.rst', '.txt', '.adoc']

/** Doc basenames with no (or an unhelpful) extension. */
const DOC_BASENAMES: readonly string[] = [
  'readme',
  'license',
  'licence',
  'changelog',
  'contributing',
  'authors',
  'notice',
  'codeowners',
]

/** Config/tooling basenames — CI, linters, formatters, type/build config, containers. */
const CONFIG_BASENAMES: readonly string[] = [
  'dockerfile',
  'containerfile',
  'docker-compose.yml',
  'docker-compose.yaml',
  'compose.yml',
  'compose.yaml',
  '.dockerignore',
  '.gitignore',
  '.gitattributes',
  '.editorconfig',
  '.npmrc',
  '.nvmrc',
  '.node-version',
  'makefile',
  'justfile',
  'procfile',
  'turbo.json',
  'knip.jsonc',
  'renovate.json',
  'wrangler.toml',
  'wrangler.jsonc',
  'pnpm-workspace.yaml',
  'lefthook.yml',
]

/** Config directories — anything under one of these is tooling/deployment config. */
const CONFIG_SEGMENTS: readonly string[] = [
  '.github',
  '.gitlab',
  '.circleci',
  '.husky',
  '.vscode',
  '.idea',
  '.changeset',
  'k8s',
  'kubernetes',
  'helm',
  'terraform',
  'deploy',
  'charts',
]

/** Test directories. */
const TEST_SEGMENTS: readonly string[] = [
  'test',
  'tests',
  '__tests__',
  '__mocks__',
  '__snapshots__',
  'e2e',
  'fixtures',
  'testdata',
]

/** Directories whose contents are database schema/migration definitions. */
const SCHEMA_SEGMENTS: readonly string[] = ['migrations', 'migration', 'drizzle', 'alembic']

/** Documentation directories. */
const DOC_SEGMENTS: readonly string[] = ['docs', 'doc', 'documentation']

/**
 * Classify ONE changed path. Order matters and encodes intent, most specific first:
 *
 *  1. `schema` — a migration/schema definition, however it is otherwise named. A `.sql` file or
 *     a file under a migrations directory is a schema change even if it also looks like config.
 *  2. `test` — a test/spec/fixture. Checked before `docs`/`source` so a `.md` snapshot fixture or
 *     a `*.test.ts` reads as a test, not as docs or code.
 *  3. `dependency` — a manifest/lockfile basename.
 *  4. `docs` — Markdown/text/doc directories, plus i18n message catalogs (user-facing COPY: a
 *     locale file is prose, not code, which is exactly the "docs/copy" bucket a policy wants).
 *  5. `config` — CI/tooling/container/IaC.
 *  6. `source` — everything else.
 *
 * Never returns `unknown`: that is reserved for "there was no changed-file list at all".
 */
export function classifyChangedPath(path: string): Exclude<ChangeClass, 'unknown'> {
  const lower = path.replaceAll('\\', '/').toLowerCase()
  const base = basenameOf(path)

  // 1. Schema / migrations.
  if (lower.endsWith('.sql') || hasSegment(lower, SCHEMA_SEGMENTS)) return 'schema'
  // A drizzle-style snapshot travels beside its migration.sql inside the migrations dir, which
  // the segment check already caught; a top-level `schema.ts` under a `db/` dir is the other
  // canonical schema-definition site.
  if (/(^|\/)db\/schema(\.[a-z]+)?\.[cm]?ts$/.test(lower)) return 'schema'

  // 2. Tests / fixtures.
  if (/\.(test|spec)(-d)?\.[cm]?[jt]sx?$/.test(lower)) return 'test'
  if (/_test\.(go|py|rb)$/.test(lower) || /(^|\/)test_[^/]+\.py$/.test(lower)) return 'test'
  if (hasSegment(lower, TEST_SEGMENTS)) return 'test'

  // 3. Dependency manifests + lockfiles.
  if (DEPENDENCY_BASENAMES.includes(base)) return 'dependency'

  // 4. Documentation + user-facing copy.
  if (DOC_EXTENSIONS.some((ext) => base.endsWith(ext))) return 'docs'
  if (DOC_BASENAMES.includes(base.replace(/\.[^.]+$/, ''))) return 'docs'
  if (hasSegment(lower, DOC_SEGMENTS)) return 'docs'
  // i18n message catalogs are prose the product SHOWS a user — the "copy" half of docs/copy.
  if (/(^|\/)(i18n|locales|lang|translations)\/.*\.(json|ya?ml)$/.test(lower)) return 'docs'

  // 5. CI / tooling / container / IaC config.
  if (CONFIG_BASENAMES.includes(base)) return 'config'
  if (hasSegment(lower, CONFIG_SEGMENTS)) return 'config'
  if (/(^|\/)(tsconfig|jsconfig)[^/]*\.json$/.test(lower)) return 'config'
  if (/(^|\/)\.?(oxlintrc|eslintrc|prettierrc|babelrc|swcrc)[^/]*$/.test(lower)) return 'config'
  if (/\.config\.[cm]?[jt]s$/.test(lower)) return 'config'
  if (/\.(tf|tfvars)$/.test(lower)) return 'config'

  // 6. Everything else is code.
  return 'source'
}

/** The verdict of classifying a whole pull request. */
export interface ChangeClassification {
  /** The dominant (highest-ranked) class present, or `unknown` for an empty/absent file list. */
  changeClass: ChangeClass
  /** How many files were classified (0 when the list was empty/absent). */
  fileCount: number
}

/**
 * Classify a pull request from the paths it changed, taking the HIGHEST-RANKED class present
 * (see {@link CHANGE_CLASS_RANK}). Deterministic and order-independent: the same set of paths
 * always yields the same class, regardless of the order the VCS returned them in.
 *
 * An empty list yields `unknown` (with `fileCount: 0`) rather than guessing — and `unknown`
 * never matches a per-class rule, so a diff we could not read can never widen the merge policy.
 */
export function classifyChangedFiles(paths: readonly string[]): ChangeClassification {
  let winner: ChangeClass = 'unknown'
  let fileCount = 0
  for (const path of paths) {
    if (path.trim() === '') continue
    fileCount += 1
    const cls = classifyChangedPath(path)
    if (CHANGE_CLASS_RANK[cls] > CHANGE_CLASS_RANK[winner]) winner = cls
  }
  return { changeClass: winner, fileCount }
}

/**
 * The rule a preset applies to a given change class: the explicit entry when there is one, else
 * `thresholds` (so an empty/absent rule map behaves exactly as it did before per-class rules).
 *
 * `unknown` ALWAYS resolves to `thresholds` — no rule may match it. This is the invariant that
 * keeps a classification failure inert: a transient VCS outage falls back to the score
 * comparison instead of silently adopting a widened (or tightened) policy.
 */
export function resolveMergeClassRule(
  rules: MergeClassRules | null | undefined,
  changeClass: ChangeClass,
): MergeClassRule {
  if (changeClass === 'unknown') return 'thresholds'
  return rules?.[changeClass] ?? 'thresholds'
}
