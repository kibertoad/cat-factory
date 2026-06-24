import {
  type AcceptanceCriterion,
  type BlockType,
  type BlueprintModule,
  type BlueprintService,
  type BlueprintVersion,
  type DomainRule,
  type RequirementGroup,
  type RequirementItem,
  type RequirementKind,
  type RequirementPriority,
  type SpecDoc,
  type SpecVersion,
  BLUEPRINT_JSON_PATH,
  BLUEPRINT_MODULES_DIR,
  BLUEPRINT_OVERVIEW_PATH,
  BLUEPRINT_VERSION_PATH,
  SPEC_FEATURES_DIR,
  SPEC_JSON_PATH,
  SPEC_OVERVIEW_PATH,
  SPEC_RULES_PATH,
  SPEC_VERSION_PATH,
} from '@cat-factory/contracts'

// Deterministic rendering + lenient coercion of the in-repo `blueprints/` and
// `spec/` artifacts. This logic used to live inside the executor-harness image
// (blueprint.ts / spec.ts); it is mechanical, deterministic, and needs no container,
// so it lives here as plain backend TypeScript invoked from an agent's post-op. The
// container's generic explore agent returns the model's JSON object; a post-op runs
// `coerce*` (lenient: fills fallbacks, dedupes ids, slices to limits — mirrors the
// strict Valibot schema in @cat-factory/contracts, which still re-validates the tree
// before it touches the board) then `render*Files` and commits the result via the
// `RepoFiles` port. Pure functions: same input → same bytes (golden-file tested), so
// an unchanged artifact produces no commit.
//
// The content hash (part of the version manifest) uses Web Crypto so these stay
// runtime-neutral (Node + workerd, no `node:crypto`), which is why the hash + version
// helpers are async. They must NOT move into @cat-factory/contracts, which is
// browser-safe and Valibot-only.

/** A repo-relative file to write (path + UTF-8 content). */
export interface RenderedFile {
  path: string
  content: string
}

/** SHA-256 hex digest — Web Crypto, runs on both runtimes. */
async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

// ---------------------------------------------------------------------------
// Blueprint (service → modules)
// ---------------------------------------------------------------------------

// Coercion limits, mirroring the board-scan schema so a committed blueprint can
// never balloon past what the board/schema accept.
const MAX_MODULES = 40
const MAX_REFERENCES = 40

// The board frame types a service may present as. Kept in lockstep with
// @cat-factory/contracts `blockTypeSchema`.
const BLOCK_TYPES: readonly BlockType[] = [
  'frontend',
  'service',
  'api',
  'database',
  'queue',
  'integration',
  'external',
  'environment',
]

function coerceReferences(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  for (const raw of value) {
    const path = asString(raw)
    if (path) seen.add(path)
    if (seen.size >= MAX_REFERENCES) break
  }
  return [...seen]
}

function coerceModule(value: unknown): BlueprintModule | null {
  if (typeof value !== 'object' || value === null) return null
  const obj = value as Record<string, unknown>
  const name = asString(obj.name)
  if (!name) return null
  return {
    name,
    summary: asString(obj.summary) ?? '',
    references: coerceReferences(obj.references),
  }
}

/**
 * Coerce an agent's parsed JSON into a well-formed {@link BlueprintService},
 * dropping anything malformed. Returns null when no usable service name remains.
 * Tolerates either a bare service object or `{ service: {...} }`. The strict Valibot
 * `parseBlueprintService` re-validates the result before it touches the board.
 */
export function coerceBlueprintService(
  parsed: unknown,
  fallbackName: string,
): BlueprintService | null {
  if (typeof parsed !== 'object' || parsed === null) return null
  const root = parsed as Record<string, unknown>
  const obj =
    typeof root.service === 'object' && root.service !== null
      ? (root.service as Record<string, unknown>)
      : root
  const name = asString(obj.name) ?? asString(fallbackName)
  if (!name) return null
  const type = BLOCK_TYPES.includes(obj.type as BlockType) ? (obj.type as BlockType) : 'service'
  const modules = (Array.isArray(obj.modules) ? obj.modules : [])
    .map(coerceModule)
    .filter((m): m is BlueprintModule => m !== null)
    .slice(0, MAX_MODULES)
  return {
    type,
    name,
    summary: asString(obj.summary) ?? '',
    references: coerceReferences(obj.references),
    modules,
  }
}

/** Turn a module name into a stable, filesystem-safe slug for its deep-dive file. */
export function moduleSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'module'
}

/** The exact canonical JSON bytes written to `blueprint.json` (and hashed). */
export function canonicalBlueprintJson(service: BlueprintService): string {
  return `${JSON.stringify(service, null, 2)}\n`
}

/** A stable content hash of the blueprint tree, used for quick staleness checks. */
export function hashBlueprint(service: BlueprintService): Promise<string> {
  return sha256Hex(canonicalBlueprintJson(service))
}

/** Render the lightweight `version.json` manifest for `service`. */
export async function renderBlueprintVersionFile(
  service: BlueprintService,
  meta: { version: number; generatedAt: string },
): Promise<RenderedFile> {
  const manifest: BlueprintVersion = {
    version: meta.version,
    generatedAt: meta.generatedAt,
    hash: await hashBlueprint(service),
    modules: (service.modules ?? []).length,
  }
  return { path: BLUEPRINT_VERSION_PATH, content: `${JSON.stringify(manifest, null, 2)}\n` }
}

/**
 * Decide the version manifest for a freshly generated tree: when the content is
 * byte-identical to the previous generation the version + timestamp are kept (so an
 * unchanged blueprint produces no diff and no commit); otherwise the counter is
 * bumped and the timestamp refreshed.
 */
export async function nextBlueprintVersion(
  service: BlueprintService,
  previous: BlueprintVersion | null,
  now: Date,
): Promise<{ version: number; generatedAt: string }> {
  if (previous && previous.hash === (await hashBlueprint(service))) {
    return { version: previous.version, generatedAt: previous.generatedAt }
  }
  return { version: (previous?.version ?? 0) + 1, generatedAt: now.toISOString() }
}

function renderReferences(references: string[]): string[] {
  if (references.length === 0) return []
  return ['', '**Code references:**', ...references.map((r) => `- \`${r}\``)]
}

/**
 * Deterministically render a blueprint tree into the in-repo artifact files: the
 * canonical `blueprint.json`, a high-level `overview.md` (service + each module with
 * a one-line summary — what agents read first), and one `modules/<slug>.md` deep-dive
 * per module (summary + code references). Pure: same tree → same bytes.
 */
export function renderBlueprintFiles(service: BlueprintService): RenderedFile[] {
  const files: RenderedFile[] = []
  const modules = service.modules ?? []

  files.push({ path: BLUEPRINT_JSON_PATH, content: canonicalBlueprintJson(service) })

  const overview: string[] = [`# ${service.name}`, '']
  overview.push('> Generated service blueprint. Read this overview first for the')
  overview.push('> high-level structure; open `modules/<name>.md` only for a module')
  overview.push('> directly relevant to your task.')
  overview.push('')
  if (service.summary) overview.push(service.summary, '')
  if (modules.length === 0) {
    overview.push('_No modules mapped yet._')
  } else {
    overview.push('## Modules', '')
    for (const m of modules) {
      const slug = moduleSlug(m.name)
      overview.push(`### [${m.name}](modules/${slug}.md)`)
      if (m.summary) overview.push('', m.summary)
      overview.push('')
    }
  }
  files.push({ path: BLUEPRINT_OVERVIEW_PATH, content: `${overview.join('\n').trimEnd()}\n` })

  for (const m of modules) {
    const slug = moduleSlug(m.name)
    const lines: string[] = [`# ${m.name}`, '']
    if (m.summary) lines.push(m.summary, '')
    lines.push(...renderReferences(m.references ?? []))
    files.push({
      path: `${BLUEPRINT_MODULES_DIR}/${slug}.md`,
      content: `${lines.join('\n').trimEnd()}\n`,
    })
  }

  return files
}

// ---------------------------------------------------------------------------
// Spec (service → groups → requirements → acceptance, + domain rules)
// ---------------------------------------------------------------------------

const MAX_GROUPS = 40
const MAX_REQUIREMENTS_PER_GROUP = 60
const MAX_ACCEPTANCE = 20
const MAX_RULES = 100

const PRIORITIES: readonly RequirementPriority[] = ['must', 'should', 'could']
const KINDS: readonly RequirementKind[] = ['functional', 'nonfunctional', 'constraint']

function slugify(name: string, fallback: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || fallback
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

// A fallback acceptance id is derived deterministically from its owning requirement
// id + position (`<reqId>-ac-<n>`), so the SAME doc always renders the SAME bytes — no
// module-global counter that leaks state across calls. A model-supplied id still wins.
function coerceAcceptance(
  value: unknown,
  reqId: string,
  index: number,
): AcceptanceCriterion | null {
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
  return { id: asString(o.id) ?? `${reqId}-ac-${index + 1}`, given, when, outcome }
}

function coerceRequirement(value: unknown, index: number): RequirementItem | null {
  if (typeof value !== 'object' || value === null) return null
  const o = value as Record<string, unknown>
  const title = asString(o.title)
  const statement = asString(o.statement) ?? asString(o.title)
  if (!statement) return null
  const priority = PRIORITIES.includes(o.priority as RequirementPriority)
    ? (o.priority as RequirementPriority)
    : 'should'
  const kind = KINDS.includes(o.kind as RequirementKind)
    ? (o.kind as RequirementKind)
    : 'functional'
  const id = asString(o.id) ?? `req-${slugify(title ?? statement.slice(0, 40), `${index + 1}`)}`
  const acceptance = (Array.isArray(o.acceptance) ? o.acceptance : [])
    .map((a, i) => coerceAcceptance(a, id, i))
    .filter((a): a is AcceptanceCriterion => a !== null)
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

function coerceGroup(value: unknown): RequirementGroup | null {
  if (typeof value !== 'object' || value === null) return null
  const o = value as Record<string, unknown>
  const name = asString(o.name)
  if (!name) return null
  const requirements = (Array.isArray(o.requirements) ? o.requirements : [])
    .map((r, i) => coerceRequirement(r, i))
    .filter((r): r is RequirementItem => r !== null)
    .slice(0, MAX_REQUIREMENTS_PER_GROUP)
  return { name, summary: asString(o.summary) ?? '', requirements }
}

function coerceRule(value: unknown, index: number): DomainRule | null {
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
 * Force every requirement / acceptance / rule id in the doc to be globally unique (in
 * place), suffixing `-2`, `-3` … on collision — the same scheme the feature-file slugs
 * use. Ids double as Gherkin scenario / test names and provenance anchors, so
 * duplicates would otherwise silently alias. Deterministic: same tree → same ids.
 */
export function dedupeSpecIds(doc: SpecDoc): void {
  const used = new Set<string>()
  for (const g of doc.groups ?? []) {
    for (const r of g.requirements ?? []) {
      r.id = uniqueId(r.id, used)
      for (const a of r.acceptance ?? []) a.id = uniqueId(a.id, used)
    }
  }
  for (const rule of doc.rules ?? []) rule.id = uniqueId(rule.id, used)
}

/**
 * Coerce an agent's parsed JSON into a well-formed {@link SpecDoc}, dropping anything
 * malformed. Returns null when no usable service name remains. Tolerates either a bare
 * doc object or `{ requirements: {...} }`. The strict `parseSpecDoc` re-validates the
 * returned doc before use.
 */
export function coerceSpecDoc(parsed: unknown, fallbackName: string): SpecDoc | null {
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
    .filter((g): g is RequirementGroup => g !== null)
    .slice(0, MAX_GROUPS)
  const rules = (Array.isArray(obj.rules) ? obj.rules : [])
    .map((r, i) => coerceRule(r, i))
    .filter((r): r is DomainRule => r !== null)
    .slice(0, MAX_RULES)
  const doc: SpecDoc = { service, summary: asString(obj.summary) ?? '', groups, rules }
  dedupeSpecIds(doc)
  return doc
}

/** The exact canonical JSON bytes written to `spec.json` (and hashed). */
export function canonicalSpecJson(doc: SpecDoc): string {
  return `${JSON.stringify(doc, null, 2)}\n`
}

/** A stable content hash of the spec doc, used for quick staleness checks. */
export function hashSpec(doc: SpecDoc): Promise<string> {
  return sha256Hex(canonicalSpecJson(doc))
}

function countRequirements(doc: SpecDoc): number {
  return (doc.groups ?? []).reduce((n, g) => n + (g.requirements ?? []).length, 0)
}

/** Render the lightweight `version.json` manifest for `doc`. */
export async function renderSpecVersionFile(
  doc: SpecDoc,
  meta: { version: number; generatedAt: string },
): Promise<RenderedFile> {
  const manifest: SpecVersion = {
    version: meta.version,
    generatedAt: meta.generatedAt,
    hash: await hashSpec(doc),
    requirements: countRequirements(doc),
    rules: (doc.rules ?? []).length,
  }
  return { path: SPEC_VERSION_PATH, content: `${JSON.stringify(manifest, null, 2)}\n` }
}

/**
 * Decide the version manifest for a freshly generated doc: when the content is
 * byte-identical to the previous generation the version + timestamp are kept (so an
 * unchanged doc produces no diff and no commit); otherwise the counter is bumped and
 * the timestamp refreshed. Mirrors {@link nextBlueprintVersion}.
 */
export async function nextSpecVersion(
  doc: SpecDoc,
  previous: SpecVersion | null,
  now: Date,
): Promise<{ version: number; generatedAt: string }> {
  if (previous && previous.hash === (await hashSpec(doc))) {
    return { version: previous.version, generatedAt: previous.generatedAt }
  }
  return { version: (previous?.version ?? 0) + 1, generatedAt: now.toISOString() }
}

/**
 * Deterministically render a spec doc into the in-repo artifact files: the canonical
 * `spec.json`, a high-level `overview.md` (intent + every group's requirements), and a
 * `rules.md` of the cross-cutting domain rules. Pure: same doc → same bytes.
 */
export function renderSpecFiles(doc: SpecDoc): RenderedFile[] {
  const files: RenderedFile[] = []
  const groups = doc.groups ?? []
  const domainRules = doc.rules ?? []

  files.push({ path: SPEC_JSON_PATH, content: canonicalSpecJson(doc) })

  const overview: string[] = [`# ${doc.service} — Requirements`, '']
  overview.push('> Generated, prescriptive requirements for this service (what MUST be')
  overview.push('> true). Read this first. `rules.md` lists cross-cutting invariants;')
  overview.push('> `features/*.feature` are the acceptance scenarios your work must satisfy.')
  overview.push('')
  if (doc.summary) overview.push(doc.summary, '')
  if (groups.length === 0) {
    overview.push('_No requirements captured yet._')
  } else {
    for (const g of groups) {
      overview.push(`## ${g.name}`)
      if (g.summary) overview.push('', g.summary)
      overview.push('')
      for (const r of g.requirements ?? []) {
        overview.push(`- **${r.title}** _(${r.priority}, ${r.kind})_ — ${r.statement}`)
        for (const a of r.acceptance ?? []) {
          overview.push(`  - _Given_ ${a.given} _When_ ${a.when} _Then_ ${a.outcome}`)
        }
      }
      overview.push('')
    }
  }
  files.push({ path: SPEC_OVERVIEW_PATH, content: `${overview.join('\n').trimEnd()}\n` })

  const rules: string[] = [`# ${doc.service} — Domain rules`, '']
  rules.push('> Cross-cutting invariants and constraints this service must never violate.')
  rules.push('')
  if (domainRules.length === 0) {
    rules.push('_No domain rules captured yet._')
  } else {
    for (const r of domainRules) {
      rules.push(`- **${r.rule}**`)
      if (r.rationale) rules.push(`  - _Why:_ ${r.rationale}`)
    }
  }
  files.push({ path: SPEC_RULES_PATH, content: `${rules.join('\n').trimEnd()}\n` })

  return files
}

/**
 * Pass-1 (mechanical) Gherkin render: one `.feature` file per requirement group, one
 * `Scenario` per acceptance criterion. Deterministic (same doc → same bytes), so the
 * feature files can never silently drift from `spec.json`; a `must` requirement's
 * scenarios are tagged `@must`. The `acceptance` agent later polishes these (pass 2).
 * Groups with no acceptance criteria produce no feature file. The caller seeds these
 * once (writes only when absent) so pass-2 polish survives a re-run.
 */
export function renderSpecFeatureFiles(doc: SpecDoc): RenderedFile[] {
  const files: RenderedFile[] = []
  const used = new Set<string>()
  for (const g of doc.groups ?? []) {
    const scenarios: string[] = []
    for (const r of g.requirements ?? []) {
      const acceptance = r.acceptance ?? []
      for (let i = 0; i < acceptance.length; i++) {
        const a = acceptance[i]!
        const name = acceptance.length > 1 ? `${r.title} (#${i + 1})` : r.title
        if (r.priority === 'must') scenarios.push('  @must')
        scenarios.push(`  Scenario: ${name}`)
        if (a.given) scenarios.push(`    Given ${a.given}`)
        if (a.when) scenarios.push(`    When ${a.when}`)
        scenarios.push(`    Then ${a.outcome}`)
        scenarios.push('')
      }
    }
    if (scenarios.length === 0) continue
    let slug = slugify(g.name, 'feature')
    let n = 2
    while (used.has(slug)) slug = `${slugify(g.name, 'feature')}-${n++}`
    used.add(slug)
    const lines: string[] = [`Feature: ${g.name}`]
    if (g.summary) lines.push(`  ${g.summary}`)
    lines.push('')
    lines.push(...scenarios)
    files.push({
      path: `${SPEC_FEATURES_DIR}/${slug}.feature`,
      content: `${lines.join('\n').trimEnd()}\n`,
    })
  }
  return files
}
