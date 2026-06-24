import { access, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'
import type { SpecJob, SpecResult, SpecTaskContext } from './job.js'
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
  unusableFinalAnswerCause,
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
const SPEC_SHAPE_HINT =
  'Expected a requirements document with a two-level taxonomy — module (domain) → ' +
  'group (feature) — where each group carries BOTH its requirements and the domain ' +
  'rules scoped to it: {"service": string, "summary": string, "modules": [{"name": ' +
  'string, "summary": string, "groups": [{"name": string, "summary": string, ' +
  '"requirements": [{"id": string, "title": string, "statement": string, "kind": ' +
  'string, "priority": string, "sourceBlockIds": string[], "acceptance": [{"given": ' +
  'string, "when": string, "outcome": string}]}], "rules": [{"id": string, "rule": ' +
  'string, "rationale": string, "sourceBlockIds": string[]}]}]}]}.'

// Runs one "spec" job end to end. The spec-writer agent gets the implementation
// branch (created from base when it does not exist yet — this step runs BEFORE the
// coder, seeding the branch the coder then resumes), reads any existing spec, and
// (re)generates the unified PRESCRIPTIVE specification document for the service from
// the combined task context. The harness deterministically SHARDS that document into
// the in-repo `spec/` folder — a tiny `service.json`, an `overview.md` index, and one
// canonical `modules/<module>/<group>.json` (+ `<group>.md`) per feature group, plus
// the Gherkin `features/<module>/<group>.feature` files — then commits the result onto
// the branch. Sharding is the whole point: a single monolithic `spec.json` made every
// concurrent task branch conflict on a whole-file rewrite. The document is also
// returned to the Worker so it can persist + surface it.
//
// Mirrors handleBlueprint's secret handling and watchdog wiring: the per-job
// GitHub + proxy tokens arrive in the request body and live only for the job's
// duration in an ephemeral workspace; `opts` carry the watchdog signal and the
// progress callback.

// The folder + file layout, kept in lockstep with @cat-factory/contracts
// (SPEC_DIR / SPEC_SERVICE_PATH / SPEC_MODULES_DIR / …). Duplicated here because the
// harness image is deliberately self-contained (no @cat-factory/contracts dep).
const SPEC_DIR = 'spec'
const SPEC_SERVICE_PATH = `${SPEC_DIR}/service.json`
const SPEC_OVERVIEW_PATH = `${SPEC_DIR}/overview.md`
const SPEC_MODULES_DIR = `${SPEC_DIR}/modules`
const SPEC_FEATURES_DIR = `${SPEC_DIR}/features`
// Monolithic-layout files from before the spec was sharded. They are never written any
// more, so a migrated repo would otherwise carry a stale, never-updated spec.json /
// rules.md / version.json forever. Deleted on every write (pre-1.0 no-compat policy:
// break old shapes, don't migrate them). The old FLAT `features/*.feature` files are
// pruned separately — see listLegacyFeatureFiles.
const LEGACY_SPEC_FILES = [
  `${SPEC_DIR}/spec.json`,
  `${SPEC_DIR}/rules.md`,
  `${SPEC_DIR}/version.json`,
]

// Coercion limits so a committed doc can never balloon past what the schema accepts.
const MAX_MODULES = 40
const MAX_GROUPS_PER_MODULE = 40
const MAX_REQUIREMENTS_PER_GROUP = 60
const MAX_ACCEPTANCE = 20
const MAX_RULES_PER_GROUP = 100

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
export interface DomainRuleTree {
  id: string
  rule: string
  rationale: string
  sourceBlockIds: string[]
}
export interface RequirementGroupTree {
  name: string
  summary: string
  requirements: RequirementItemTree[]
  rules: DomainRuleTree[]
}
export interface SpecModuleTree {
  name: string
  summary: string
  groups: RequirementGroupTree[]
}
export interface SpecDocTree {
  service: string
  summary: string
  modules: SpecModuleTree[]
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

// A fallback rule id is derived from the rule text (`rule-<slug>`), NOT its position,
// so reordering a group's rules never changes their ids and the group file stays
// byte-stable. A model-supplied id still wins.
function coerceRule(value: unknown, index: number): DomainRuleTree | null {
  if (typeof value !== 'object' || value === null) return null
  const o = value as Record<string, unknown>
  const rule = asString(o.rule)
  if (!rule) return null
  return {
    id: asString(o.id) ?? `rule-${slugify(rule.slice(0, 60), `${index + 1}`)}`,
    rule,
    rationale: asString(o.rationale) ?? '',
    sourceBlockIds: coerceStringList(o.sourceBlockIds, 40),
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
  const rules = (Array.isArray(o.rules) ? o.rules : [])
    .map((r, i) => coerceRule(r, i))
    .filter((r): r is DomainRuleTree => r !== null)
    .slice(0, MAX_RULES_PER_GROUP)
  return { name, summary: asString(o.summary) ?? '', requirements, rules }
}

function coerceModule(value: unknown): SpecModuleTree | null {
  if (typeof value !== 'object' || value === null) return null
  const o = value as Record<string, unknown>
  const name = asString(o.name)
  if (!name) return null
  const groups = (Array.isArray(o.groups) ? o.groups : [])
    .map(coerceGroup)
    .filter((g): g is RequirementGroupTree => g !== null)
    .slice(0, MAX_GROUPS_PER_MODULE)
  return { name, summary: asString(o.summary) ?? '', groups }
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
function dedupeIds(doc: SpecDocTree): void {
  const used = new Set<string>()
  // Traverse in the SAME name-sorted order the renderer shards in, so a cross-group id
  // collision's `-N` suffix lands on a deterministic group regardless of the order the
  // agent happened to emit modules/groups in. Iterating the raw arrays would let a
  // reordered-but-identical doc bake a different suffix into the affected group shards,
  // reintroducing exactly the merge churn sharding exists to kill.
  const modules = [...doc.modules].sort((a, b) => a.name.localeCompare(b.name))
  for (const m of modules) {
    const groups = [...m.groups].sort((a, b) => a.name.localeCompare(b.name))
    for (const g of groups) {
      for (const r of g.requirements) {
        r.id = uniqueId(r.id, used)
        for (const a of r.acceptance) a.id = uniqueId(a.id, used)
      }
      for (const rule of g.rules) rule.id = uniqueId(rule.id, used)
    }
  }
}

/**
 * Coerce an agent's parsed JSON into a well-formed {@link SpecDocTree},
 * dropping anything malformed. Returns null when no usable service name remains.
 * Tolerates either a bare doc object or `{ requirements: {...} }`. The Worker
 * re-validates the returned doc against the strict Valibot schema before use.
 */
export function coerceSpecDoc(parsed: unknown, fallbackName: string): SpecDocTree | null {
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
  const modules = (Array.isArray(obj.modules) ? obj.modules : [])
    .map(coerceModule)
    .filter((m): m is SpecModuleTree => m !== null)
    .slice(0, MAX_MODULES)
  // Lenient safety net: a model that ignored the taxonomy and returned flat top-level
  // `groups` (or whose `modules` were all malformed, so nothing survived coercion) gets
  // those groups wrapped into one module named after the service, so its work is not
  // dropped. Keyed on the COERCED result, not the raw array length, so a non-empty but
  // junk `modules` alongside real `groups` still rescues the groups. The strict Valibot
  // schema (modules-only) and the steering prompt make this rare; it is NOT a compat path
  // for old on-disk specs.
  if (modules.length === 0 && Array.isArray(obj.groups) && obj.groups.length > 0) {
    const wrapped = coerceModule({ name: service, summary: '', groups: obj.groups })
    if (wrapped) modules.push(wrapped)
  }
  const doc = { service, summary: asString(obj.summary) ?? '', modules }
  dedupeIds(doc)
  return doc
}

/** A repo-relative file the harness writes (path + UTF-8 content). */
export interface RenderedFile {
  path: string
  content: string
}

/** The exact canonical JSON bytes written to a per-group shard. */
function canonicalJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

/**
 * Assign each item a stable, collision-free, filesystem-safe slug. Items are processed
 * name-sorted so collision suffixes (`-2`, `-3`, …) are deterministic regardless of the
 * order the agent emitted them — the same set of names always yields the same slugs.
 */
function assignSlugs<T>(items: T[], nameOf: (t: T) => string): Map<T, string> {
  const used = new Set<string>()
  const out = new Map<T, string>()
  const sorted = [...items].sort((a, b) => nameOf(a).localeCompare(nameOf(b)))
  for (const item of sorted) {
    const base = slugify(nameOf(item), 'item')
    let slug = base
    let n = 2
    while (used.has(slug)) slug = `${base}-${n++}`
    used.add(slug)
    out.set(item, slug)
  }
  return out
}

interface GroupRef {
  module: SpecModuleTree
  group: RequirementGroupTree
  moduleSlug: string
  groupSlug: string
}

interface ModuleRef {
  module: SpecModuleTree
  moduleSlug: string
  groups: Array<{ group: RequirementGroupTree; groupSlug: string }>
}

/**
 * Walk the doc into name-sorted modules with their resolved slugs and their name-sorted
 * groups. The single source of slug/sort truth for every renderer — computed once here
 * rather than re-derived (and re-filtered per module) at each call site.
 */
function walkModules(doc: SpecDocTree): ModuleRef[] {
  const moduleSlugs = assignSlugs(doc.modules, (m) => m.name)
  const modules = [...doc.modules].sort((a, b) => a.name.localeCompare(b.name))
  return modules.map((module) => {
    const groupSlugs = assignSlugs(module.groups, (g) => g.name)
    const groups = [...module.groups]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((group) => ({ group, groupSlug: groupSlugs.get(group)! }))
    return { module, moduleSlug: moduleSlugs.get(module)!, groups }
  })
}

/** Flatten {@link walkModules} into one ref per group (for the feature-file render). */
function walkGroups(doc: SpecDocTree): GroupRef[] {
  const out: GroupRef[] = []
  for (const { module, moduleSlug, groups } of walkModules(doc)) {
    for (const { group, groupSlug } of groups) {
      out.push({ module, group, moduleSlug, groupSlug })
    }
  }
  return out
}

/** The human-readable render of one feature group (its requirements + scoped rules). */
function renderGroupMarkdown(module: SpecModuleTree, group: RequirementGroupTree): string {
  const lines: string[] = [`# ${module.name} — ${group.name}`, '']
  if (group.summary) lines.push(group.summary, '')
  if (group.requirements.length === 0) {
    lines.push('_No requirements captured yet._', '')
  } else {
    lines.push('## Requirements', '')
    for (const r of group.requirements) {
      lines.push(`- **${r.title}** _(${r.priority}, ${r.kind})_ — ${r.statement}`)
      for (const a of r.acceptance) {
        lines.push(`  - _Given_ ${a.given} _When_ ${a.when} _Then_ ${a.outcome}`)
      }
    }
    lines.push('')
  }
  if (group.rules.length > 0) {
    lines.push('## Domain rules', '')
    for (const r of group.rules) {
      lines.push(`- **${r.rule}**`)
      if (r.rationale) lines.push(`  - _Why:_ ${r.rationale}`)
    }
    lines.push('')
  }
  return `${lines.join('\n').trimEnd()}\n`
}

/**
 * Deterministically SHARD a spec doc into the in-repo artifact files: a tiny
 * `service.json`, an `overview.md` index (modules → features with links), and per
 * feature group a canonical `modules/<module>/<group>.json` + a human `<group>.md`
 * (plus a `_module.json` per module). Pure: same doc → same bytes, and a group file's
 * bytes depend only on that group — so two task branches editing different features
 * never touch the same file.
 */
export function renderSpecFiles(doc: SpecDocTree): RenderedFile[] {
  const files: RenderedFile[] = []

  files.push({
    path: SPEC_SERVICE_PATH,
    content: canonicalJson({ service: doc.service, summary: doc.summary }),
  })

  const moduleRefs = walkModules(doc)

  // overview.md — the index agents read first (names + links only, never the bodies).
  const overview: string[] = [`# ${doc.service} — Specification`, '']
  overview.push('> Prescriptive spec for this service (what MUST be true). This index lists the')
  overview.push('> modules and their features; open `modules/<module>/<feature>.md` for detail')
  overview.push('> and `features/<module>/*.feature` for the acceptance scenarios to satisfy.')
  overview.push('')
  if (doc.summary) overview.push(doc.summary, '')
  if (moduleRefs.length === 0) {
    overview.push('_No requirements captured yet._')
  } else {
    for (const { module, moduleSlug, groups } of moduleRefs) {
      overview.push(`## ${module.name}`)
      if (module.summary) overview.push('', module.summary)
      overview.push('')
      if (groups.length === 0) {
        overview.push('_No features captured yet._', '')
        continue
      }
      for (const { group, groupSlug } of groups) {
        const detail = group.summary ? ` — ${group.summary}` : ''
        overview.push(`- [${group.name}](modules/${moduleSlug}/${groupSlug}.md)${detail}`)
      }
      overview.push('')
    }
  }
  files.push({ path: SPEC_OVERVIEW_PATH, content: `${overview.join('\n').trimEnd()}\n` })

  for (const { module, moduleSlug } of moduleRefs) {
    files.push({
      path: `${SPEC_MODULES_DIR}/${moduleSlug}/_module.json`,
      content: canonicalJson({ name: module.name, summary: module.summary }),
    })
  }

  for (const { module, moduleSlug, groups } of moduleRefs) {
    for (const { group, groupSlug } of groups) {
      files.push({
        path: `${SPEC_MODULES_DIR}/${moduleSlug}/${groupSlug}.json`,
        content: canonicalJson(group),
      })
      files.push({
        path: `${SPEC_MODULES_DIR}/${moduleSlug}/${groupSlug}.md`,
        content: renderGroupMarkdown(module, group),
      })
    }
  }

  return files
}

/**
 * Pass-1 (mechanical) Gherkin render: one `features/<module>/<group>.feature` file per
 * feature group, one `Scenario` per acceptance criterion. Deterministic (same doc →
 * same bytes); a `must` requirement's scenarios are tagged `@must`. The `acceptance`
 * agent later polishes these (pass 2). Groups with no acceptance criteria produce no
 * feature file.
 */
export function renderFeatureFiles(doc: SpecDocTree): RenderedFile[] {
  const files: RenderedFile[] = []
  for (const { module, group, moduleSlug, groupSlug } of walkGroups(doc)) {
    const scenarios: string[] = []
    for (const r of group.requirements) {
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
    const lines: string[] = [`Feature: ${module.name} — ${group.name}`]
    if (group.summary) lines.push(`  ${group.summary}`)
    lines.push('')
    lines.push(...scenarios)
    files.push({
      path: `${SPEC_FEATURES_DIR}/${moduleSlug}/${groupSlug}.feature`,
      content: `${lines.join('\n').trimEnd()}\n`,
    })
  }
  return files
}

/**
 * Reassemble the existing sharded spec from disk (so the agent refines in place). Reads
 * `service.json` for the service name/summary and every `modules/<m>/<g>.json` shard
 * (skipping `_module.json`), grouping them back into the module → group tree, then runs
 * the lenient coercion to normalise. Returns null when no shards are present (fresh repo).
 */
export async function readExistingSpec(
  dir: string,
  fallbackName: string,
): Promise<SpecDocTree | null> {
  let service = fallbackName
  let summary = ''
  try {
    const raw = JSON.parse(await readFile(join(dir, SPEC_SERVICE_PATH), 'utf8')) as Record<
      string,
      unknown
    >
    if (typeof raw.service === 'string' && raw.service.trim()) service = raw.service
    if (typeof raw.summary === 'string') summary = raw.summary
  } catch {
    // No service.json — fall through; modules may still exist (or this is a fresh repo).
  }

  const modulesDir = join(dir, SPEC_MODULES_DIR)
  let moduleNames: string[]
  try {
    const entries = await readdir(modulesDir, { withFileTypes: true })
    moduleNames = entries.filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return null
  }
  if (moduleNames.length === 0) return null

  const modules: Array<Record<string, unknown>> = []
  for (const moduleSlug of moduleNames.sort()) {
    const modulePath = join(modulesDir, moduleSlug)
    let moduleName = moduleSlug
    let moduleSummary = ''
    try {
      const meta = JSON.parse(await readFile(join(modulePath, '_module.json'), 'utf8')) as Record<
        string,
        unknown
      >
      if (typeof meta.name === 'string' && meta.name.trim()) moduleName = meta.name
      if (typeof meta.summary === 'string') moduleSummary = meta.summary
    } catch {
      // No `_module.json`; fall back to the slug as the module name.
    }
    const groupFiles = (await readdir(modulePath))
      .filter((f) => f.endsWith('.json') && f !== '_module.json')
      .sort()
    const groups: unknown[] = []
    for (const file of groupFiles) {
      try {
        groups.push(JSON.parse(await readFile(join(modulePath, file), 'utf8')))
      } catch {
        // Skip an unreadable / malformed shard rather than failing the whole reassembly.
      }
    }
    modules.push({ name: moduleName, summary: moduleSummary, groups })
  }

  return coerceSpecDoc({ service, summary, modules }, fallbackName)
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

/** Render this task's requirements that the agent applies onto the baseline spec. */
function renderTask(task: SpecTaskContext): string {
  const header = `### ${task.title || '(untitled task)'}${task.id ? ` (block ${task.id})` : ''}`
  return `${header}\n\n${task.description || '(no description)'}`
}

/** Render the existing module → feature taxonomy so the agent reuses slots, not duplicates them. */
function renderTaxonomyInventory(existing: SpecDocTree): string[] {
  const lines: string[] = [
    '',
    'EXISTING taxonomy (modules → features). Map each new requirement/rule into the',
    'closest-fitting EXISTING module and feature below, reusing its EXACT name. Create a',
    'new module or feature ONLY when nothing here fits — never a near-duplicate of an',
    'existing one (e.g. do not add "Authentication" when "Auth" exists, or "User Login"',
    'when "Login" exists). A cross-cutting concern belongs in a `common`/`infrastructure`',
    'module, itself split into specific features — never a catch-all bucket.',
    '',
  ]
  if (existing.modules.length === 0) {
    lines.push('_(none yet — you are starting the taxonomy)_')
    return lines
  }
  for (const module of existing.modules) {
    lines.push(`- ${module.name}`)
    for (const group of module.groups) lines.push(`  - ${group.name}`)
  }
  return lines
}

/** Compose the task prompt: the worker's guidance, the baseline spec, and this task. */
function buildUserPrompt(job: SpecJob, existing: SpecDocTree | null): string {
  const lines = [job.instructions.trim()]
  if (existing) {
    lines.push(
      '',
      'The specification ALREADY committed to the repository is the baseline (the spec',
      'as merged before this task). Keep every part of it that this task does not touch',
      'exactly as-is, preserving its `sourceBlockIds`. Adjust an existing requirement',
      'only where this task changes its expected behaviour. Return the COMPLETE updated',
      'document (baseline plus this task’s increment), not a diff.',
    )
    lines.push(...renderTaxonomyInventory(existing))
    lines.push('', 'Baseline specification:', '```json', JSON.stringify(existing, null, 2), '```')
  } else {
    lines.push(
      '',
      'No specification exists in the repository yet, so this task starts a new one.',
      'Organise it as a module (domain) → feature (group) taxonomy: place each requirement',
      'and rule in a specific feature under a specific module; keep cross-cutting concerns',
      'in a `common`/`infrastructure` module split into specific features (no catch-all).',
    )
  }
  lines.push(
    '',
    'Requirements for the ONE task to apply as an increment (its clarified description).',
    'Translate ONLY what these state into prescriptive requirements with complete',
    'acceptance-scenario coverage — do NOT invent requirements or fill gaps they leave:',
    '',
    renderTask(job.task),
  )
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

/** List every canonical shard file currently under `spec/modules/` (repo-relative, `/`-joined). */
async function listExistingModuleFiles(dir: string): Promise<string[]> {
  const base = join(dir, SPEC_MODULES_DIR)
  try {
    const rels = await readdir(base, { recursive: true })
    return rels
      .map((r) => `${SPEC_MODULES_DIR}/${r.split(sep).join('/')}`)
      .filter((p) => p.endsWith('.json') || p.endsWith('.md'))
  } catch {
    return []
  }
}

/**
 * Old FLAT-layout Gherkin files written directly under `spec/features/` before features
 * were nested under `features/<module>/`. The sharded renderer never targets a top-level
 * `.feature`, so any such file is a stale orphan that would otherwise feed spec-aware
 * agents acceptance scenarios with no live requirements behind them — prune them.
 */
async function listLegacyFeatureFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(join(dir, SPEC_FEATURES_DIR), { withFileTypes: true })
    return entries
      .filter((e) => e.isFile() && e.name.endsWith('.feature'))
      .map((e) => `${SPEC_FEATURES_DIR}/${e.name}`)
  } catch {
    return []
  }
}

/**
 * Write the rendered files under `dir` and reconcile the canonical shards.
 *
 * The spec-writer OWNS the canonical artifact (`service.json`, `overview.md`, the
 * per-group `modules/<m>/<g>.{json,md}`) and always rewrites it. Because these are
 * canonical (not seed-once), a module/group that the new doc no longer contains is an
 * ORPHAN that must be DELETED — otherwise the next reassembly would resurrect it. So
 * after writing we remove any `modules/**` `.json`/`.md` file the render did not emit
 * (`git add -A` in `commitAll` then stages the deletion).
 *
 * The Gherkin `features/<m>/<g>.feature` files are the exception: they are SEEDED
 * (written only when absent, never overwritten OR deleted) so a later manual refinement
 * of a scenario survives a re-run. A removed group's seed feature file may linger; that
 * is harmless and far cheaper than destroying hand-edited scenarios.
 *
 * Finally, the pre-sharding monolithic artifacts (`spec.json` / `rules.md` /
 * `version.json` and the old FLAT `features/*.feature` files) are deleted on sight so a
 * migrated repo never carries a stale, never-updated spec alongside the shards.
 */
export async function writeRequirementsFiles(dir: string, files: RenderedFile[]): Promise<void> {
  const desired = new Set(files.map((f) => f.path))
  for (const file of files) {
    const abs = join(dir, file.path)
    const isFeature = file.path.startsWith(`${SPEC_FEATURES_DIR}/`)
    if (isFeature && (await fileExists(abs))) continue // seed-once: don't clobber pass-2 polish.
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, file.content, 'utf8')
  }
  // Prune orphaned canonical shards (a removed/renamed module or group).
  for (const existing of await listExistingModuleFiles(dir)) {
    if (!desired.has(existing)) await rm(join(dir, existing), { force: true })
  }
  // Drop stale monolithic-layout artifacts left by a pre-sharding repo.
  for (const legacy of [...LEGACY_SPEC_FILES, ...(await listLegacyFeatureFiles(dir))]) {
    await rm(join(dir, legacy), { force: true })
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
  job: SpecJob,
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
export async function handleSpec(job: SpecJob, opts: RunOptions = {}): Promise<SpecResult> {
  const { signal } = opts
  const trace = { jobId: job.jobId, repo: `${job.repo.owner}/${job.repo.name}`, branch: job.branch }
  return withWorkspace('requirements', async (dir) => {
    log.info('requirements: checking out implementation branch', trace)
    await checkoutOrCreateBranch(job, dir, signal)

    const existing = await readExistingSpec(dir, job.repo.name)

    log.info('requirements: running agent', { ...trace, task: job.task.id })
    const {
      summary,
      stats,
      stderrTail,
      usage,
      diagnostics: runDiag,
    } = await runAgentInWorkspace(
      {
        dir,
        systemPrompt: job.systemPrompt,
        userPrompt: buildUserPrompt(job, existing),
        model: job.model,
        harness: job.harness,
        subscriptionToken: job.subscriptionToken,
        subscriptionBaseUrl: job.subscriptionBaseUrl,
        proxyBaseUrl: job.proxyBaseUrl,
        sessionToken: job.sessionToken,
        // The agent RETURNS the requirements document as JSON — the harness renders
        // + commits the files (below); the agent never calls an edit/write tool. So
        // the no-edit guard must be off (like the blueprinter / merger).
        expectsEdits: false,
      },
      opts,
    )

    // The spec is HANDED OFF to the spec-companion to review, so an unusable final
    // answer (cut off at the output ceiling, or an empty completion) must fail LOUDLY
    // here — not get laundered into a half-baked doc by the structured repair below,
    // which is how the companion ended up looping on an "unreviewable" artifact. Opt-in
    // per agent (see `unusableFinalAnswerCause`): only document producers gate on it.
    const unusable = unusableFinalAnswerCause(runDiag)
    if (unusable) {
      log.warn('requirements: unusable final answer', { ...trace, ...stats, ...runDiag })
      return {
        summary,
        stats,
        error: `the requirements agent did not return a usable specification: ${unusable}.${agentOutputTail(stderrTail, summary)}`,
        ...(usage ? { usage } : {}),
      }
    }

    // Parse the agent's document; on a malformed reply, make ONE structured repair
    // call (see json-repair) before giving up. Both the failure and the repair
    // outcome are logged + folded into the failure reason for observability.
    const { value: doc, diagnostics } = await resolveStructuredOutput(
      {
        label: 'requirements',
        shapeHint: SPEC_SHAPE_HINT,
        parse: (text) => coerceSpecDoc(extractJsonObject(text), job.repo.name),
      },
      summary,
      {
        harness: job.harness,
        subscriptionToken: job.subscriptionToken,
        subscriptionBaseUrl: job.subscriptionBaseUrl,
        proxyBaseUrl: job.proxyBaseUrl,
        sessionToken: job.sessionToken,
        model: job.model,
        jobId: job.jobId,
        signal,
      },
    )
    if (!doc) {
      return {
        summary,
        stats,
        error: noRequirementsReason(stats, summary, stderrTail, diagnostics),
        ...(usage ? { usage } : {}),
      }
    }

    await writeRequirementsFiles(dir, [...renderSpecFiles(doc), ...renderFeatureFiles(doc)])

    // Add one commit onto the branch (no history reset, no force). Sharded, deterministic
    // rendering means an unchanged group's bytes are identical, so `commitAll` finds
    // nothing staged and makes no commit (no version.json counter to bump) — we still
    // return the doc so the ingest is idempotent.
    const committed = await commitAll(dir, 'Update service requirements', signal)
    if (committed) {
      log.info('requirements: pushing regenerated requirements', { ...trace, ...stats })
      await pushBranch(dir, job.branch, job.ghToken, signal)
    } else {
      log.info('requirements: no changes to push (requirements unchanged)', trace)
    }

    return { spec: doc, summary, stats, ...(usage ? { usage } : {}) }
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
