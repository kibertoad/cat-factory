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
  type SpecModule,
  BLUEPRINT_JSON_PATH,
  BLUEPRINT_MODULES_DIR,
  BLUEPRINT_OVERVIEW_PATH,
  BLUEPRINT_VERSION_PATH,
  SPEC_FEATURES_DIR,
  SPEC_MODULES_DIR,
  SPEC_OVERVIEW_PATH,
  SPEC_SERVICE_PATH,
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

const MAX_SPEC_MODULES = 40
const MAX_GROUPS_PER_MODULE = 40
const MAX_REQUIREMENTS_PER_GROUP = 60
const MAX_ACCEPTANCE = 20
const MAX_RULES_PER_GROUP = 100

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

// A fallback rule id is derived from the rule text (`rule-<slug>`), NOT its position,
// so reordering a group's rules never changes their ids and the group file stays
// byte-stable. A model-supplied id still wins.
function coerceRule(value: unknown, index: number): DomainRule | null {
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

function coerceGroup(value: unknown): RequirementGroup | null {
  if (typeof value !== 'object' || value === null) return null
  const o = value as Record<string, unknown>
  const name = asString(o.name)
  if (!name) return null
  const requirements = (Array.isArray(o.requirements) ? o.requirements : [])
    .map((r, i) => coerceRequirement(r, i))
    .filter((r): r is RequirementItem => r !== null)
    .slice(0, MAX_REQUIREMENTS_PER_GROUP)
  const rules = (Array.isArray(o.rules) ? o.rules : [])
    .map((r, i) => coerceRule(r, i))
    .filter((r): r is DomainRule => r !== null)
    .slice(0, MAX_RULES_PER_GROUP)
  return { name, summary: asString(o.summary) ?? '', requirements, rules }
}

function coerceSpecModule(value: unknown): SpecModule | null {
  if (typeof value !== 'object' || value === null) return null
  const o = value as Record<string, unknown>
  const name = asString(o.name)
  if (!name) return null
  const groups = (Array.isArray(o.groups) ? o.groups : [])
    .map(coerceGroup)
    .filter((g): g is RequirementGroup => g !== null)
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
 * Force every requirement / acceptance / rule id in the doc to be globally unique (in
 * place), suffixing `-2`, `-3` … on collision — the same scheme the feature-file slugs
 * use. Ids double as Gherkin scenario / test names and provenance anchors, so
 * duplicates would otherwise silently alias. Deterministic: same tree → same ids.
 */
export function dedupeSpecIds(doc: SpecDoc): void {
  const used = new Set<string>()
  // Traverse in the SAME name-sorted order the renderer shards in, so a cross-group id
  // collision's `-N` suffix lands on a deterministic group regardless of the order the
  // agent happened to emit modules/groups in — otherwise a reordered-but-identical doc
  // would bake a different suffix into the affected group shards and reintroduce the merge
  // churn sharding exists to kill.
  const modules = [...(doc.modules ?? [])].sort((a, b) => a.name.localeCompare(b.name))
  for (const m of modules) {
    const groups = [...(m.groups ?? [])].sort((a, b) => a.name.localeCompare(b.name))
    for (const g of groups) {
      for (const r of g.requirements ?? []) {
        r.id = uniqueId(r.id, used)
        for (const a of r.acceptance ?? []) a.id = uniqueId(a.id, used)
      }
      for (const rule of g.rules ?? []) rule.id = uniqueId(rule.id, used)
    }
  }
}

/**
 * Coerce an agent's parsed JSON into a well-formed {@link SpecDoc}, dropping anything
 * malformed. Returns null when no usable service name remains. Tolerates either a bare
 * doc object or `{ requirements: {...} }`, and wraps stray top-level `groups` into one
 * module (a lenient safety net for a model that ignored the taxonomy — NOT a compat path
 * for old on-disk specs). The strict `parseSpecDoc` re-validates the returned doc.
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
  const modules = (Array.isArray(obj.modules) ? obj.modules : [])
    .map(coerceSpecModule)
    .filter((m): m is SpecModule => m !== null)
    .slice(0, MAX_SPEC_MODULES)
  // Lenient safety net keyed on the COERCED result (not the raw array length): a model
  // that returned flat top-level `groups`, or whose `modules` were all malformed so
  // nothing survived, gets those groups wrapped into one module named after the service
  // so its work is not dropped. NOT a compat path for old on-disk specs.
  if (modules.length === 0 && Array.isArray(obj.groups) && obj.groups.length > 0) {
    const wrapped = coerceSpecModule({ name: service, summary: '', groups: obj.groups })
    if (wrapped) modules.push(wrapped)
  }
  const doc: SpecDoc = { service, summary: asString(obj.summary) ?? '', modules }
  dedupeSpecIds(doc)
  return doc
}

/** The exact canonical JSON bytes written to a per-group shard. */
function canonicalJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

/**
 * Assign each item a stable, collision-free slug. Items are processed name-sorted so the
 * collision suffixes (`-2`, …) are deterministic regardless of the order the agent
 * emitted them — the same set of names always yields the same slugs.
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

interface SpecGroupRef {
  module: SpecModule
  group: RequirementGroup
  moduleSlug: string
  groupSlug: string
}

interface SpecModuleRef {
  module: SpecModule
  moduleSlug: string
  groups: Array<{ group: RequirementGroup; groupSlug: string }>
}

/**
 * Walk the doc into name-sorted modules with their resolved slugs and their name-sorted
 * groups. The single source of slug/sort truth for every renderer — computed once here
 * rather than re-derived (and re-filtered per module) at each call site.
 */
function walkSpecModules(doc: SpecDoc): SpecModuleRef[] {
  const modulesList = doc.modules ?? []
  const moduleSlugs = assignSlugs(modulesList, (m) => m.name)
  const modules = [...modulesList].sort((a, b) => a.name.localeCompare(b.name))
  return modules.map((module) => {
    const groupsList = module.groups ?? []
    const groupSlugs = assignSlugs(groupsList, (g) => g.name)
    const groups = [...groupsList]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((group) => ({ group, groupSlug: groupSlugs.get(group)! }))
    return { module, moduleSlug: moduleSlugs.get(module)!, groups }
  })
}

/** Flatten {@link walkSpecModules} into one ref per group (for the feature-file render). */
function walkSpecGroups(doc: SpecDoc): SpecGroupRef[] {
  const out: SpecGroupRef[] = []
  for (const { module, moduleSlug, groups } of walkSpecModules(doc)) {
    for (const { group, groupSlug } of groups) {
      out.push({ module, group, moduleSlug, groupSlug })
    }
  }
  return out
}

/** The human-readable render of one feature group (its requirements + scoped rules). */
function renderSpecGroupMarkdown(module: SpecModule, group: RequirementGroup): string {
  const lines: string[] = [`# ${module.name} — ${group.name}`, '']
  if (group.summary) lines.push(group.summary, '')
  const requirements = group.requirements ?? []
  if (requirements.length === 0) {
    lines.push('_No requirements captured yet._', '')
  } else {
    lines.push('## Requirements', '')
    for (const r of requirements) {
      lines.push(`- **${r.title}** _(${r.priority}, ${r.kind})_ — ${r.statement}`)
      for (const a of r.acceptance ?? []) {
        lines.push(`  - _Given_ ${a.given} _When_ ${a.when} _Then_ ${a.outcome}`)
      }
    }
    lines.push('')
  }
  const rules = group.rules ?? []
  if (rules.length > 0) {
    lines.push('## Domain rules', '')
    for (const r of rules) {
      lines.push(`- **${r.rule}**`)
      if (r.rationale) lines.push(`  - _Why:_ ${r.rationale}`)
    }
    lines.push('')
  }
  return `${lines.join('\n').trimEnd()}\n`
}

/**
 * Deterministically SHARD a spec doc into the in-repo artifact files: a tiny
 * `service.json`, an `overview.md` index (modules → features with links), a
 * `_module.json` per module, and per feature group a canonical
 * `modules/<module>/<group>.json` + a human `<group>.md`. Pure: same doc → same bytes,
 * and a group file's bytes depend only on that group. Mirrors the executor-harness
 * renderer byte-for-byte.
 */
export function renderSpecFiles(doc: SpecDoc): RenderedFile[] {
  const files: RenderedFile[] = []

  files.push({
    path: SPEC_SERVICE_PATH,
    content: canonicalJson({ service: doc.service, summary: doc.summary ?? '' }),
  })

  const moduleRefs = walkSpecModules(doc)

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
      content: canonicalJson({ name: module.name, summary: module.summary ?? '' }),
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
        content: renderSpecGroupMarkdown(module, group),
      })
    }
  }

  return files
}

/**
 * Pass-1 (mechanical) Gherkin render: one `features/<module>/<group>.feature` per
 * feature group, one `Scenario` per acceptance criterion. Deterministic; a `must`
 * requirement's scenarios are tagged `@must`. The `acceptance` agent later polishes
 * these (pass 2). Groups with no acceptance criteria produce no feature file. The caller
 * seeds these once (writes only when absent) so pass-2 polish survives a re-run.
 */
export function renderSpecFeatureFiles(doc: SpecDoc): RenderedFile[] {
  const files: RenderedFile[] = []
  for (const { module, group, moduleSlug, groupSlug } of walkSpecGroups(doc)) {
    const scenarios: string[] = []
    for (const r of group.requirements ?? []) {
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
