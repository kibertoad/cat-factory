import { createHash } from 'node:crypto'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { RequirementsJob, RequirementsResult, RequirementsTaskContext } from './job.js'
import {
  cloneExistingBranch,
  cloneRepo,
  commitAll,
  createBranch,
  pushBranch,
  remoteBranchExists,
} from './git.js'
import type { PiRunStats } from './pi.js'
import {
  agentNeverActed,
  agentOutputTail,
  NEVER_ACTED_CAUSE,
  runAgentInWorkspace,
  withWorkspace,
} from './pi-workspace.js'
import {
  type StructuredOutputDiagnostics,
  diagnosticsSuffix,
  resolveStructuredOutput,
} from './structured-output.js'
import type { RunOptions } from './runner.js'
import { log } from './logger.js'

/** Compact description of the requirements-document shape, fed to the JSON repair call. */
const REQUIREMENTS_SHAPE_HINT =
  'Expected a requirements document: {"service": string, "summary": string, ' +
  '"groups": [{"name": string, "summary": string, "requirements": [{"id": string, ' +
  '"title": string, "statement": string, "kind": string, "priority": string, ' +
  '"sourceBlockIds": string[], "acceptance": [{"given": string, "when": string, ' +
  '"outcome": string}]}]}], "rules": [{"id": string, "rule": string, "rationale": ' +
  'string, "sourceBlockIds": string[]}]}.'

// Runs one "requirements" job end to end. The requirements-writer agent gets the
// implementation branch (created from base when it does not exist yet — this step
// runs BEFORE the coder, seeding the branch the coder then resumes), reads any
// existing requirements doc, and (re)generates the unified PRESCRIPTIVE
// requirements document for the service from the combined task context. The harness
// deterministically renders that document into the in-repo `requirements/` folder
// (a machine-readable `requirements.json`, the `overview.md` / `rules.md` markdown,
// a `version.json` manifest and the Gherkin `features/*.feature` files), then
// commits the result onto the branch. The document is also returned to the Worker
// so it can persist + surface it.
//
// Mirrors handleBlueprint's secret handling and watchdog wiring: the per-job
// GitHub + proxy tokens arrive in the request body and live only for the job's
// duration in an ephemeral workspace; `opts` carry the watchdog signal and the
// progress callback.

// The folder + file layout, kept in lockstep with @cat-factory/contracts
// (REQUIREMENTS_DIR / REQUIREMENTS_JSON_PATH / …). Duplicated here because the
// harness image is deliberately self-contained (no @cat-factory/contracts dep).
const REQUIREMENTS_DIR = 'requirements'
const REQUIREMENTS_JSON_PATH = `${REQUIREMENTS_DIR}/requirements.json`
const REQUIREMENTS_OVERVIEW_PATH = `${REQUIREMENTS_DIR}/overview.md`
const REQUIREMENTS_RULES_PATH = `${REQUIREMENTS_DIR}/rules.md`
const REQUIREMENTS_VERSION_PATH = `${REQUIREMENTS_DIR}/version.json`
const REQUIREMENTS_FEATURES_DIR = `${REQUIREMENTS_DIR}/features`

// Coercion limits so a committed doc can never balloon past what the schema accepts.
const MAX_GROUPS = 40
const MAX_REQUIREMENTS_PER_GROUP = 60
const MAX_ACCEPTANCE = 20
const MAX_RULES = 100

const PRIORITIES = ['must', 'should', 'could'] as const
const KINDS = ['functional', 'nonfunctional', 'constraint'] as const

export interface AcceptanceCriterionTree {
  id: string
  given: string
  when: string
  /** The Gherkin "Then" clause; named `outcome` so the object is never thenable. */
  outcome: string
}
export interface RequirementItemTree {
  id: string
  title: string
  statement: string
  kind: string
  priority: string
  sourceBlockIds: string[]
  acceptance: AcceptanceCriterionTree[]
}
export interface RequirementGroupTree {
  name: string
  summary: string
  requirements: RequirementItemTree[]
}
export interface DomainRuleTree {
  id: string
  rule: string
  rationale: string
  sourceBlockIds: string[]
}
export interface RequirementsDocTree {
  service: string
  summary: string
  groups: RequirementGroupTree[]
  rules: DomainRuleTree[]
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function coerceStringList(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const raw of value) {
    const s = asString(raw)
    if (s) out.push(s)
    if (out.length >= max) break
  }
  return out
}

function slugify(name: string, fallback: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || fallback
}

// A fallback acceptance id is derived deterministically from its owning
// requirement id + position (`<reqId>-ac-<n>`), so the SAME doc always renders the
// SAME bytes — no module-global counter that leaks state across jobs (which would
// make an unchanged doc hash differently on a long-lived harness process and force a
// spurious version bump + commit). A model-supplied id still wins.
function coerceAcceptance(
  value: unknown,
  reqId: string,
  index: number,
): AcceptanceCriterionTree | null {
  if (typeof value !== 'object' || value === null) return null
  const o = value as Record<string, unknown>
  const given = typeof o.given === 'string' ? o.given.trim() : ''
  const when = typeof o.when === 'string' ? o.when.trim() : ''
  // Accept either `outcome` (canonical) or a model-emitted `then` as the Then clause.
  const outcome =
    typeof o.outcome === 'string'
      ? o.outcome.trim()
      : typeof o.then === 'string'
        ? o.then.trim()
        : ''
  // A criterion with no Then clause is not testable; drop it.
  if (outcome === '') return null
  return {
    id: asString(o.id) ?? `${reqId}-ac-${index + 1}`,
    given,
    when,
    outcome,
  }
}

function coerceRequirement(value: unknown, index: number): RequirementItemTree | null {
  if (typeof value !== 'object' || value === null) return null
  const o = value as Record<string, unknown>
  const title = asString(o.title)
  const statement = asString(o.statement) ?? asString(o.title)
  if (!statement) return null
  const priority = (PRIORITIES as readonly string[]).includes(o.priority as string)
    ? (o.priority as string)
    : 'should'
  const kind = (KINDS as readonly string[]).includes(o.kind as string)
    ? (o.kind as string)
    : 'functional'
  const id = asString(o.id) ?? `req-${slugify(title ?? statement.slice(0, 40), `${index + 1}`)}`
  const acceptance = (Array.isArray(o.acceptance) ? o.acceptance : [])
    .map((a, i) => coerceAcceptance(a, id, i))
    .filter((a): a is AcceptanceCriterionTree => a !== null)
    .slice(0, MAX_ACCEPTANCE)
  return {
    id,
    title: title ?? statement.slice(0, 120),
    statement,
    kind,
    priority,
    sourceBlockIds: coerceStringList(o.sourceBlockIds, 40),
    acceptance,
  }
}

function coerceGroup(value: unknown): RequirementGroupTree | null {
  if (typeof value !== 'object' || value === null) return null
  const o = value as Record<string, unknown>
  const name = asString(o.name)
  if (!name) return null
  const requirements = (Array.isArray(o.requirements) ? o.requirements : [])
    .map((r, i) => coerceRequirement(r, i))
    .filter((r): r is RequirementItemTree => r !== null)
    .slice(0, MAX_REQUIREMENTS_PER_GROUP)
  return { name, summary: asString(o.summary) ?? '', requirements }
}

function coerceRule(value: unknown, index: number): DomainRuleTree | null {
  if (typeof value !== 'object' || value === null) return null
  const o = value as Record<string, unknown>
  const rule = asString(o.rule)
  if (!rule) return null
  return {
    id: asString(o.id) ?? `rule-${index + 1}`,
    rule,
    rationale: asString(o.rationale) ?? '',
    sourceBlockIds: coerceStringList(o.sourceBlockIds, 40),
  }
}

/** Return `id` if unseen, else the first `id-2` / `id-3` … not already in `used`. */
function uniqueId(id: string, used: Set<string>): string {
  if (!used.has(id)) {
    used.add(id)
    return id
  }
  let n = 2
  while (used.has(`${id}-${n}`)) n++
  const unique = `${id}-${n}`
  used.add(unique)
  return unique
}

/**
 * Force every requirement / acceptance / rule id in the doc to be globally unique
 * (in place), suffixing `-2`, `-3` … on collision — the same scheme the feature-file
 * slugs already use. Ids double as Gherkin scenario / test names and provenance
 * anchors, so duplicates (two requirements sharing a title, a model echoing an id)
 * would otherwise silently alias. Deterministic: same tree → same ids.
 */
function dedupeIds(doc: RequirementsDocTree): void {
  const used = new Set<string>()
  for (const g of doc.groups) {
    for (const r of g.requirements) {
      r.id = uniqueId(r.id, used)
      for (const a of r.acceptance) a.id = uniqueId(a.id, used)
    }
  }
  for (const rule of doc.rules) rule.id = uniqueId(rule.id, used)
}

/**
 * Coerce an agent's parsed JSON into a well-formed {@link RequirementsDocTree},
 * dropping anything malformed. Returns null when no usable service name remains.
 * Tolerates either a bare doc object or `{ requirements: {...} }`. The Worker
 * re-validates the returned doc against the strict Valibot schema before use.
 */
export function coerceRequirementsDoc(
  parsed: unknown,
  fallbackName: string,
): RequirementsDocTree | null {
  if (typeof parsed !== 'object' || parsed === null) return null
  const root = parsed as Record<string, unknown>
  const obj =
    typeof root.requirements === 'object' &&
    root.requirements !== null &&
    !Array.isArray(root.requirements)
      ? (root.requirements as Record<string, unknown>)
      : root
  const service = asString(obj.service) ?? asString(fallbackName)
  if (!service) return null
  const groups = (Array.isArray(obj.groups) ? obj.groups : [])
    .map(coerceGroup)
    .filter((g): g is RequirementGroupTree => g !== null)
    .slice(0, MAX_GROUPS)
  const rules = (Array.isArray(obj.rules) ? obj.rules : [])
    .map((r, i) => coerceRule(r, i))
    .filter((r): r is DomainRuleTree => r !== null)
    .slice(0, MAX_RULES)
  const doc = { service, summary: asString(obj.summary) ?? '', groups, rules }
  dedupeIds(doc)
  return doc
}

/** A repo-relative file the harness writes (path + UTF-8 content). */
export interface RenderedFile {
  path: string
  content: string
}

/** The exact canonical JSON bytes written to `requirements.json` (and hashed). */
export function canonicalRequirementsJson(doc: RequirementsDocTree): string {
  return `${JSON.stringify(doc, null, 2)}\n`
}

/** A stable content hash of the requirements doc, used for quick staleness checks. */
export function hashRequirements(doc: RequirementsDocTree): string {
  return createHash('sha256').update(canonicalRequirementsJson(doc)).digest('hex')
}

/** Total requirement count across all groups. */
function countRequirements(doc: RequirementsDocTree): number {
  return doc.groups.reduce((n, g) => n + g.requirements.length, 0)
}

export interface RequirementsVersionTree {
  version: number
  generatedAt: string
  hash: string
  requirements: number
  rules: number
}

/** Read the prior version manifest, if any (to bump the counter / detect no-ops). */
async function readExistingVersion(dir: string): Promise<RequirementsVersionTree | null> {
  try {
    const raw = await readFile(join(dir, REQUIREMENTS_VERSION_PATH), 'utf8')
    const parsed = JSON.parse(raw) as Partial<RequirementsVersionTree>
    if (typeof parsed.version !== 'number' || typeof parsed.hash !== 'string') return null
    return {
      version: parsed.version,
      generatedAt: typeof parsed.generatedAt === 'string' ? parsed.generatedAt : '',
      hash: parsed.hash,
      requirements: typeof parsed.requirements === 'number' ? parsed.requirements : 0,
      rules: typeof parsed.rules === 'number' ? parsed.rules : 0,
    }
  } catch {
    return null
  }
}

/** Read + parse the existing requirements doc, if any (so the agent refines in place). */
async function readExistingRequirements(
  dir: string,
  fallbackName: string,
): Promise<RequirementsDocTree | null> {
  try {
    const raw = await readFile(join(dir, REQUIREMENTS_JSON_PATH), 'utf8')
    return coerceRequirementsDoc(JSON.parse(raw), fallbackName)
  } catch {
    return null
  }
}

/**
 * Decide the version manifest for a freshly generated doc: when the content is
 * byte-identical to the previous generation, the version + timestamp are kept (so
 * an unchanged doc produces no diff and no commit); otherwise the counter is bumped
 * and the timestamp refreshed. Mirrors the blueprint's `nextVersion`.
 */
export function nextRequirementsVersion(
  doc: RequirementsDocTree,
  previous: RequirementsVersionTree | null,
  now: Date,
): { version: number; generatedAt: string } {
  if (previous && previous.hash === hashRequirements(doc)) {
    return { version: previous.version, generatedAt: previous.generatedAt }
  }
  return { version: (previous?.version ?? 0) + 1, generatedAt: now.toISOString() }
}

/** Render the lightweight `version.json` manifest for `doc`. */
export function renderVersionFile(
  doc: RequirementsDocTree,
  meta: { version: number; generatedAt: string },
): RenderedFile {
  const manifest: RequirementsVersionTree = {
    version: meta.version,
    generatedAt: meta.generatedAt,
    hash: hashRequirements(doc),
    requirements: countRequirements(doc),
    rules: doc.rules.length,
  }
  return { path: REQUIREMENTS_VERSION_PATH, content: `${JSON.stringify(manifest, null, 2)}\n` }
}

/**
 * Deterministically render a requirements doc into the in-repo artifact files: the
 * canonical `requirements.json`, a high-level `overview.md` (intent + every group's
 * requirements — what agents read first), and a `rules.md` of the cross-cutting
 * domain rules. Pure: same doc → same bytes.
 */
export function renderRequirementsFiles(doc: RequirementsDocTree): RenderedFile[] {
  const files: RenderedFile[] = []

  files.push({ path: REQUIREMENTS_JSON_PATH, content: canonicalRequirementsJson(doc) })

  // overview.md — the default read.
  const overview: string[] = [`# ${doc.service} — Requirements`, '']
  overview.push('> Generated, prescriptive requirements for this service (what MUST be')
  overview.push('> true). Read this first. `rules.md` lists cross-cutting invariants;')
  overview.push('> `features/*.feature` are the acceptance scenarios your work must satisfy.')
  overview.push('')
  if (doc.summary) overview.push(doc.summary, '')
  if (doc.groups.length === 0) {
    overview.push('_No requirements captured yet._')
  } else {
    for (const g of doc.groups) {
      overview.push(`## ${g.name}`)
      if (g.summary) overview.push('', g.summary)
      overview.push('')
      for (const r of g.requirements) {
        overview.push(`- **${r.title}** _(${r.priority}, ${r.kind})_ — ${r.statement}`)
        for (const a of r.acceptance) {
          overview.push(`  - _Given_ ${a.given} _When_ ${a.when} _Then_ ${a.outcome}`)
        }
      }
      overview.push('')
    }
  }
  files.push({ path: REQUIREMENTS_OVERVIEW_PATH, content: `${overview.join('\n').trimEnd()}\n` })

  // rules.md — domain rules / invariants / constraints.
  const rules: string[] = [`# ${doc.service} — Domain rules`, '']
  rules.push('> Cross-cutting invariants and constraints this service must never violate.')
  rules.push('')
  if (doc.rules.length === 0) {
    rules.push('_No domain rules captured yet._')
  } else {
    for (const r of doc.rules) {
      rules.push(`- **${r.rule}**`)
      if (r.rationale) rules.push(`  - _Why:_ ${r.rationale}`)
    }
  }
  files.push({ path: REQUIREMENTS_RULES_PATH, content: `${rules.join('\n').trimEnd()}\n` })

  return files
}

/**
 * Pass-1 (mechanical) Gherkin render: one `.feature` file per requirement group,
 * one `Scenario` per acceptance criterion. Deterministic (same doc → same bytes),
 * so the feature files can never silently drift from `requirements.json`; a `must`
 * requirement's scenarios are tagged `@must`. The `acceptance` agent later polishes
 * these (pass 2). Groups with no acceptance criteria produce no feature file.
 */
export function renderFeatureFiles(doc: RequirementsDocTree): RenderedFile[] {
  const files: RenderedFile[] = []
  const used = new Set<string>()
  for (const g of doc.groups) {
    const scenarios: string[] = []
    for (const r of g.requirements) {
      for (let i = 0; i < r.acceptance.length; i++) {
        const a = r.acceptance[i]!
        const name = r.acceptance.length > 1 ? `${r.title} (#${i + 1})` : r.title
        if (r.priority === 'must') scenarios.push('  @must')
        scenarios.push(`  Scenario: ${name}`)
        if (a.given) scenarios.push(`    Given ${a.given}`)
        if (a.when) scenarios.push(`    When ${a.when}`)
        scenarios.push(`    Then ${a.outcome}`)
        scenarios.push('')
      }
    }
    if (scenarios.length === 0) continue
    // Stable, collision-free file name per group.
    let slug = slugify(g.name, 'feature')
    let n = 2
    while (used.has(slug)) slug = `${slugify(g.name, 'feature')}-${n++}`
    used.add(slug)
    const lines: string[] = [`Feature: ${g.name}`]
    if (g.summary) lines.push(`  ${g.summary}`)
    lines.push('')
    lines.push(...scenarios)
    files.push({
      path: `${REQUIREMENTS_FEATURES_DIR}/${slug}.feature`,
      content: `${lines.join('\n').trimEnd()}\n`,
    })
  }
  return files
}

/** Extract the first JSON object from an agent's final message (tolerating fences/prose). */
export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim()
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)
  const body = fenced ? (fenced[1] ?? '') : trimmed
  try {
    return JSON.parse(body)
  } catch {
    const start = body.indexOf('{')
    const end = body.lastIndexOf('}')
    if (start === -1 || end === -1 || end <= start) {
      throw new Error('agent did not return a JSON object')
    }
    return JSON.parse(body.slice(start, end + 1))
  }
}

/** Render the aggregated task context the agent folds into the service requirements. */
function renderTasks(tasks: RequirementsTaskContext[]): string {
  if (tasks.length === 0) return '_No task requirements supplied._'
  return tasks
    .map((t) => {
      const header = `### ${t.title}${t.id ? ` (block ${t.id})` : ''}`
      return `${header}\n\n${t.description || '(no description)'}`
    })
    .join('\n\n')
}

/** Compose the task prompt: the worker's guidance, the prior doc, and the task context. */
function buildUserPrompt(job: RequirementsJob, existing: RequirementsDocTree | null): string {
  const lines = [job.instructions.trim()]
  lines.push(
    '',
    'Combined requirements collected for the tasks of this service (each task’s',
    'clarified description). Fold these into ONE unified, de-duplicated, prescriptive',
    'requirements document for the whole service:',
    '',
    renderTasks(job.tasks),
  )
  if (existing) {
    lines.push(
      '',
      'An existing requirements document is present. Update it in place: keep accurate',
      'requirements, refine wording, add what is missing, and preserve provenance',
      '(`sourceBlockIds`). Return the COMPLETE updated document (not a diff).',
      '',
      'Existing requirements:',
      '```json',
      JSON.stringify(existing, null, 2),
      '```',
    )
  }
  lines.push(
    '',
    'Respond with ONLY the JSON object for the requirements document — no prose, no',
    'code fences.',
  )
  return lines.join('\n')
}

async function fileExists(abs: string): Promise<boolean> {
  try {
    await access(abs)
    return true
  } catch {
    return false
  }
}

/**
 * Write the rendered files under `dir`. The requirements-writer OWNS the canonical
 * artifact (`requirements.json`, `overview.md`, `rules.md`, `version.json`) and
 * always rewrites it. The Gherkin `features/*.feature` files are a TWO-PASS artifact:
 * this writer only does the mechanical pass-1 SEED, then the `acceptance` agent
 * polishes them in place (sharpening wording, adding edge/error scenarios). So a
 * feature file is written only when it does not already exist — never overwritten or
 * deleted — otherwise a re-run (a later `pl_full`, or a standalone `pl_requirements`)
 * would clobber the acceptance agent's polished/added scenarios. The trade-off is a
 * removed group's seed file may linger; that is far cheaper than destroying pass-2
 * work, and a stale `.feature` is harmless next to the canonical `requirements.json`.
 */
export async function writeRequirementsFiles(dir: string, files: RenderedFile[]): Promise<void> {
  for (const file of files) {
    const abs = join(dir, file.path)
    const isFeature = file.path.startsWith(`${REQUIREMENTS_FEATURES_DIR}/`)
    if (isFeature && (await fileExists(abs))) continue // seed-once: don't clobber pass-2 polish.
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, file.content, 'utf8')
  }
}

/**
 * Clone the implementation `branch`, creating it from `repo.baseBranch` when it does
 * not exist yet. This step runs BEFORE the coder, so on the first task run the branch
 * is absent and we seed it; on a re-run (or after the coder has pushed) it already
 * exists and we resume on it, so the requirements commit lands on the same branch the
 * coder uses. Returns once the checkout in `dir` is on `branch` with commit identity set.
 */
async function checkoutOrCreateBranch(
  job: RequirementsJob,
  dir: string,
  signal?: AbortSignal,
): Promise<void> {
  const exists = await remoteBranchExists(job.repo.cloneUrl, job.branch, job.ghToken, signal)
  if (exists) {
    await cloneExistingBranch({
      cloneUrl: job.repo.cloneUrl,
      branch: job.branch,
      ghToken: job.ghToken,
      dir,
      signal,
    })
    return
  }
  await cloneRepo({ repo: job.repo, ghToken: job.ghToken, dir, signal })
  await createBranch(dir, job.branch, signal)
}

/** Run one requirements job end to end. */
export async function handleRequirements(
  job: RequirementsJob,
  opts: RunOptions = {},
): Promise<RequirementsResult> {
  const { signal } = opts
  const trace = { jobId: job.jobId, repo: `${job.repo.owner}/${job.repo.name}`, branch: job.branch }
  return withWorkspace('requirements', async (dir) => {
    log.info('requirements: checking out implementation branch', trace)
    await checkoutOrCreateBranch(job, dir, signal)

    const existing = await readExistingRequirements(dir, job.repo.name)
    const previousVersion = await readExistingVersion(dir)

    log.info('requirements: running agent', { ...trace, tasks: job.tasks.length })
    const { summary, stats, stderrTail } = await runAgentInWorkspace(
      {
        dir,
        systemPrompt: job.systemPrompt,
        userPrompt: buildUserPrompt(job, existing),
        model: job.model,
        proxyBaseUrl: job.proxyBaseUrl,
        sessionToken: job.sessionToken,
        // The agent RETURNS the requirements document as JSON — the harness renders
        // + commits the files (below); the agent never calls an edit/write tool. So
        // the no-edit guard must be off (like the blueprinter / merger).
        expectsEdits: false,
      },
      opts,
    )

    // Parse the agent's document; on a malformed reply, make ONE structured repair
    // call (see json-repair) before giving up. Both the failure and the repair
    // outcome are logged + folded into the failure reason for observability.
    const { value: doc, diagnostics } = await resolveStructuredOutput(
      {
        label: 'requirements',
        shapeHint: REQUIREMENTS_SHAPE_HINT,
        parse: (text) => coerceRequirementsDoc(extractJsonObject(text), job.repo.name),
      },
      summary,
      {
        proxyBaseUrl: job.proxyBaseUrl,
        sessionToken: job.sessionToken,
        model: job.model,
        jobId: job.jobId,
        signal,
      },
    )
    if (!doc) {
      return { summary, stats, error: noRequirementsReason(stats, summary, stderrTail, diagnostics) }
    }

    const version = nextRequirementsVersion(doc, previousVersion, new Date())
    await writeRequirementsFiles(dir, [
      ...renderRequirementsFiles(doc),
      ...renderFeatureFiles(doc),
      renderVersionFile(doc, version),
    ])

    // Add one commit onto the branch (no history reset, no force). An unchanged doc
    // produces no commit — we still return the doc so the ingest is idempotent.
    const committed = await commitAll(dir, 'Update service requirements', signal)
    if (committed) {
      log.info('requirements: pushing regenerated requirements', { ...trace, ...stats })
      await pushBranch(dir, job.branch, job.ghToken, signal)
    } else {
      log.info('requirements: no changes to push (requirements unchanged)', trace)
    }

    return { requirements: doc, summary, stats }
  })
}

/** Human-readable reason a requirements run produced no usable document. */
function noRequirementsReason(
  stats: PiRunStats,
  summary: string,
  stderrTail: string | undefined,
  diagnostics?: StructuredOutputDiagnostics,
): string {
  const cause = agentNeverActed(stats) ? NEVER_ACTED_CAUSE : ''
  return (
    `the requirements agent produced no usable document ` +
    `(tool calls: ${stats.toolCalls}, assistant output: ${stats.assistantChars} chars).${cause}` +
    (diagnostics ? diagnosticsSuffix(diagnostics) : '') +
    agentOutputTail(stderrTail, summary)
  )
}
