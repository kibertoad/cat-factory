import {
  type Initiative,
  type InitiativeDraftItem,
  type InitiativeEstimate,
  type InitiativeExecutionPolicy,
  type InitiativeItem,
  type InitiativePipelineRule,
  type InitiativePlanDraft,
  type InitiativeVersion,
  initiativeJsonPath,
  initiativeTrackerPath,
  initiativeVersionPath,
} from '@cat-factory/contracts'
import type { RepoFiles } from '@cat-factory/kernel'
import { type RenderedFile, moduleSlug } from './render.js'

// Deterministic rendering + lenient coercion of the in-repo initiative tracker
// (`docs/initiatives/<slug>/`) — the initiative sibling of the blueprint artifact
// helpers in `render.ts`. The DB `initiatives` row is the source of truth; these
// render a PROJECTION of it (canonical `initiative.json` + human `tracker.md` +
// a tiny `version.json` staleness manifest) and commit it idempotently over the
// checkout-free `RepoFiles` port. Pure render: same entity view → same bytes.
//
// The content hash deliberately excludes the volatile bookkeeping (`rev`,
// `updatedAt`, `doc`) — hashing those would make every DB write look like a
// content change and defeat the no-change commit short-circuit.

// Coercion limits, mirroring the contracts schema bounds so a coerced plan can
// never balloon past what `parseInitiativePlanDraft` accepts.
const MAX_PHASES = 12
const MAX_ITEMS = 100
const MAX_LIST_ENTRIES = 40
const MAX_TITLE = 200
const MAX_SHORT = 2000
const MAX_PROSE = 8000
const MAX_CONCURRENT = 20

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function clamp01(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.max(0, Math.min(1, value))
}

function clampConcurrency(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.max(1, Math.min(MAX_CONCURRENT, Math.round(value)))
}

function coerceStringList(value: unknown, maxLength: number): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const raw of value) {
    const s = asString(raw)
    if (s) out.push(s.slice(0, maxLength))
    if (out.length >= MAX_LIST_ENTRIES) break
  }
  return out
}

function coerceEstimate(value: unknown): InitiativeEstimate | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const obj = value as Record<string, unknown>
  const complexity = clamp01(obj.complexity)
  const risk = clamp01(obj.risk)
  const impact = clamp01(obj.impact)
  if (complexity === null || risk === null || impact === null) return undefined
  return {
    complexity,
    risk,
    impact,
    rationale: (asString(obj.rationale) ?? '').slice(0, MAX_SHORT),
  }
}

function coerceRules(value: unknown): InitiativePipelineRule[] {
  if (!Array.isArray(value)) return []
  const rules: InitiativePipelineRule[] = []
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) continue
    const obj = raw as Record<string, unknown>
    const pipelineId = asString(obj.pipelineId)
    if (!pipelineId) continue
    const minComplexity = clamp01(obj.minComplexity)
    const minRisk = clamp01(obj.minRisk)
    const minImpact = clamp01(obj.minImpact)
    rules.push({
      pipelineId: pipelineId.slice(0, 80),
      ...(minComplexity !== null ? { minComplexity } : {}),
      ...(minRisk !== null ? { minRisk } : {}),
      ...(minImpact !== null ? { minImpact } : {}),
    })
    if (rules.length >= MAX_LIST_ENTRIES) break
  }
  return rules
}

/**
 * Coerce the planner agent's policy object. `defaultPipelineId` falls back to the
 * built-in full pipeline when the model omitted it — a plan without a fallback
 * pipeline would strand the execution loop on every estimate-less item.
 */
function coercePolicy(value: unknown): InitiativeExecutionPolicy {
  const obj = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
  return {
    maxConcurrent: clampConcurrency(obj.maxConcurrent) ?? 1,
    rules: coerceRules(obj.rules),
    defaultPipelineId: (asString(obj.defaultPipelineId) ?? 'pl_full').slice(0, 80),
    onMissingEstimate: obj.onMissingEstimate === 'strongest' ? 'strongest' : 'default',
  }
}

/** Assign a unique slug-derived id, suffixing `-2`, `-3`, … on collision. */
function uniqueSlugId(base: string, taken: Set<string>): string {
  const slug = moduleSlug(base).slice(0, 60)
  let candidate = slug
  let n = 2
  while (taken.has(candidate)) candidate = `${slug}-${n++}`
  taken.add(candidate)
  return candidate
}

/**
 * Coerce an agent's parsed JSON into a well-formed {@link InitiativePlanDraft},
 * dropping anything malformed — the initiative sibling of `coerceBlueprintService`.
 * Every phase/item receives a deterministic slug-derived id (the model's own id is
 * kept when present); an item whose `phaseId` matches no phase (by id OR by title
 * slug) is dropped rather than guessed. Returns null when no usable phase+item
 * structure remains. The strict Valibot `parseInitiativePlanDraft` re-validates
 * the result at every trust boundary.
 */
export function coerceInitiativePlan(parsed: unknown): InitiativePlanDraft | null {
  if (typeof parsed !== 'object' || parsed === null) return null
  const root = parsed as Record<string, unknown>
  const obj =
    typeof root.plan === 'object' && root.plan !== null
      ? (root.plan as Record<string, unknown>)
      : root

  const phaseIds = new Set<string>()
  // providedId/titleSlug → final id, so items can reference phases either way.
  const phaseIdMap = new Map<string, string>()
  const phases: InitiativePlanDraft['phases'] = []
  for (const raw of Array.isArray(obj.phases) ? obj.phases : []) {
    if (typeof raw !== 'object' || raw === null) continue
    const p = raw as Record<string, unknown>
    const title = asString(p.title)
    if (!title) continue
    const id = uniqueSlugId(asString(p.id) ?? title, phaseIds)
    const provided = asString(p.id)
    if (provided) phaseIdMap.set(provided, id)
    phaseIdMap.set(moduleSlug(title), id)
    const maxConcurrent = clampConcurrency(p.maxConcurrent)
    phases.push({
      id,
      title: title.slice(0, MAX_TITLE),
      goal: (asString(p.goal) ?? '').slice(0, MAX_SHORT),
      ...(maxConcurrent !== undefined ? { maxConcurrent } : {}),
    })
    if (phases.length >= MAX_PHASES) break
  }
  if (phases.length === 0) return null

  const itemIds = new Set<string>()
  const itemIdMap = new Map<string, string>()
  const rawItems: Array<{ item: InitiativeDraftItem; rawDeps: string[] }> = []
  for (const raw of Array.isArray(obj.items) ? obj.items : []) {
    if (typeof raw !== 'object' || raw === null) continue
    const it = raw as Record<string, unknown>
    const title = asString(it.title)
    const phaseRef = asString(it.phaseId)
    if (!title || !phaseRef) continue
    const phaseId = phaseIdMap.get(phaseRef) ?? phaseIdMap.get(moduleSlug(phaseRef))
    if (!phaseId) continue
    const id = uniqueSlugId(asString(it.id) ?? title, itemIds)
    const provided = asString(it.id)
    if (provided) itemIdMap.set(provided, id)
    itemIdMap.set(moduleSlug(title), id)
    const estimate = coerceEstimate(it.estimate)
    const pipelineId = asString(it.pipelineId)
    rawItems.push({
      item: {
        id,
        phaseId,
        title: title.slice(0, MAX_TITLE),
        description: (asString(it.description) ?? '').slice(0, MAX_PROSE),
        dependsOn: [],
        ...(estimate ? { estimate } : {}),
        ...(pipelineId ? { pipelineId: pipelineId.slice(0, 80) } : {}),
      },
      rawDeps: Array.isArray(it.dependsOn)
        ? it.dependsOn.filter((d): d is string => typeof d === 'string')
        : [],
    })
    if (rawItems.length >= MAX_ITEMS) break
  }
  if (rawItems.length === 0) return null

  // Resolve dependencies once every item id is known; unknown refs are dropped.
  const items: InitiativeDraftItem[] = rawItems.map(({ item, rawDeps }) => {
    const deps = new Set<string>()
    for (const dep of rawDeps) {
      const resolved = itemIdMap.get(dep.trim()) ?? itemIdMap.get(moduleSlug(dep))
      if (resolved && resolved !== item.id) deps.add(resolved)
    }
    return { ...item, dependsOn: [...deps] }
  })

  const decisions: InitiativePlanDraft['decisions'] = []
  for (const raw of Array.isArray(obj.decisions) ? obj.decisions : []) {
    if (typeof raw !== 'object' || raw === null) continue
    const d = raw as Record<string, unknown>
    const title = asString(d.title)
    if (!title) continue
    decisions.push({
      title: title.slice(0, MAX_TITLE),
      detail: (asString(d.detail) ?? '').slice(0, MAX_SHORT),
    })
    if (decisions.length >= MAX_LIST_ENTRIES) break
  }

  return {
    goal: (asString(obj.goal) ?? '').slice(0, MAX_PROSE),
    constraints: coerceStringList(obj.constraints, MAX_SHORT),
    nonGoals: coerceStringList(obj.nonGoals, MAX_SHORT),
    analysisSummary: (asString(obj.analysisSummary) ?? '').slice(0, MAX_PROSE),
    phases,
    items,
    policy: coercePolicy(obj.policy),
    decisions,
    caveats: coerceStringList(obj.caveats, MAX_SHORT),
  }
}

// ---------------------------------------------------------------------------
// Rendering (entity → committed tracker files)
// ---------------------------------------------------------------------------

/** SHA-256 hex digest — Web Crypto, runs on both runtimes. */
async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * The CONTENT view of an initiative — the entity minus the volatile bookkeeping
 * (`rev`, `updatedAt`, `doc`) that changes on every DB write without the plan
 * itself changing. This is what gets committed as `initiative.json` and hashed,
 * so a no-op tick never produces a commit.
 */
export function initiativeContentView(initiative: Initiative): Record<string, unknown> {
  const { rev: _rev, updatedAt: _updatedAt, doc: _doc, ...content } = initiative
  return content
}

/** The exact canonical JSON bytes written to `initiative.json` (and hashed). */
export function canonicalInitiativeJson(initiative: Initiative): string {
  return `${JSON.stringify(initiativeContentView(initiative), null, 2)}\n`
}

/** A stable content hash of the initiative's plan content (bookkeeping excluded). */
export function hashInitiative(initiative: Initiative): Promise<string> {
  return sha256Hex(canonicalInitiativeJson(initiative))
}

/**
 * Decide the version manifest for a freshly rendered tracker: byte-identical
 * content keeps the previous version + timestamp (no diff, no commit); a change
 * bumps the counter and refreshes the timestamp.
 */
export async function nextInitiativeVersion(
  initiative: Initiative,
  previous: InitiativeVersion | null,
  now: Date,
): Promise<{ version: number; generatedAt: string }> {
  if (previous && previous.hash === (await hashInitiative(initiative))) {
    return { version: previous.version, generatedAt: previous.generatedAt }
  }
  return { version: (previous?.version ?? 0) + 1, generatedAt: now.toISOString() }
}

/** Render the lightweight `version.json` manifest. */
export async function renderInitiativeVersionFile(
  initiative: Initiative,
  meta: { version: number; generatedAt: string },
): Promise<RenderedFile> {
  const manifest: InitiativeVersion = {
    version: meta.version,
    generatedAt: meta.generatedAt,
    hash: await hashInitiative(initiative),
    items: initiative.items?.length ?? 0,
  }
  return {
    path: initiativeVersionPath(initiative.slug),
    content: `${JSON.stringify(manifest, null, 2)}\n`,
  }
}

const ITEM_STATUS_MARK: Record<InitiativeItem['status'], string> = {
  pending: '⬜ pending',
  in_progress: '🔄 in progress',
  pr_open: '🔗 PR open',
  done: '✅ done',
  blocked: '⚠️ blocked',
  skipped: '⏭️ skipped',
}

function renderItemRow(item: InitiativeItem): string {
  const pr = item.pr ? `[#${item.pr.number ?? 'PR'}](${item.pr.url})` : '—'
  const deps = item.dependsOn?.length ? item.dependsOn.map((d) => `\`${d}\``).join(', ') : '—'
  return `| \`${item.id}\` | ${item.title} | ${ITEM_STATUS_MARK[item.status]} | ${pr} | ${deps} |`
}

function section(title: string, lines: string[]): string[] {
  return lines.length === 0 ? [] : ['', `## ${title}`, '', ...lines]
}

/**
 * Deterministically render the human-readable `tracker.md` — the CLAUDE.md
 * tracker-document convention: status header, goal & rationale, the per-item
 * checklist tables (one per phase, with status + PR links), the execution
 * policy, and the decisions / deviations / follow-ups / caveats logs.
 */
export function renderInitiativeTrackerMarkdown(initiative: Initiative): string {
  const lines: string[] = [
    `# Initiative: ${initiative.title}`,
    '',
    `**Status:** ${initiative.status} · **Started:** ${new Date(initiative.createdAt).toISOString().slice(0, 10)}`,
    '',
    '> Generated initiative tracker (rendered from the platform’s initiative entity).',
    '> The per-item checklist is updated as the execution loop settles each item.',
  ]

  if (initiative.goal) lines.push('', '## Goal & rationale', '', initiative.goal)
  lines.push(
    ...section(
      'Constraints',
      (initiative.constraints ?? []).map((c) => `- ${c}`),
    ),
  )
  lines.push(
    ...section(
      'Non-goals',
      (initiative.nonGoals ?? []).map((g) => `- ${g}`),
    ),
  )
  if (initiative.analysisSummary) {
    lines.push('', '## Codebase analysis', '', initiative.analysisSummary)
  }

  const items = initiative.items ?? []
  for (const phase of initiative.phases ?? []) {
    const phaseItems = items.filter((i) => i.phaseId === phase.id)
    lines.push('', `## Phase: ${phase.title}`, '')
    if (phase.goal) lines.push(phase.goal, '')
    if (phaseItems.length === 0) {
      lines.push('_No items._')
      continue
    }
    lines.push(
      '| Item | Title | Status | PR | Depends on |',
      '| --- | --- | --- | --- | --- |',
      ...phaseItems.map(renderItemRow),
    )
  }

  const policy = initiative.policy
  if (policy) {
    const ruleLines = policy.rules.map((r) => {
      const axes = [
        r.minComplexity !== undefined ? `complexity ≥ ${r.minComplexity}` : null,
        r.minRisk !== undefined ? `risk ≥ ${r.minRisk}` : null,
        r.minImpact !== undefined ? `impact ≥ ${r.minImpact}` : null,
      ].filter((a): a is string => a !== null)
      return `- \`${r.pipelineId}\` when ${axes.length ? axes.join(' OR ') : 'never (no thresholds)'}`
    })
    lines.push(
      '',
      '## Execution policy',
      '',
      `- Max concurrent tasks: ${policy.maxConcurrent}`,
      ...ruleLines,
      `- Default pipeline: \`${policy.defaultPipelineId}\``,
    )
  }

  lines.push(
    ...section(
      'Decisions',
      (initiative.decisions ?? []).map(
        (d) => `- **${d.title}** (${d.source})${d.detail ? ` — ${d.detail}` : ''}`,
      ),
    ),
  )
  lines.push(
    ...section(
      'Deviations',
      (initiative.deviations ?? []).map(
        (d) =>
          `- ${d.itemId ? `\`${d.itemId}\`: ` : ''}${d.description}${d.resolution ? ` → ${d.resolution}` : ''}`,
      ),
    ),
  )
  lines.push(
    ...section(
      'Follow-ups',
      (initiative.followUps ?? []).map(
        (f) => `- [${f.status}] **${f.title}**${f.detail ? ` — ${f.detail}` : ''}`,
      ),
    ),
  )
  lines.push(
    ...section(
      'Known caveats',
      (initiative.caveats ?? []).map((c) => `- ${c}`),
    ),
  )
  lines.push(
    ...section(
      'Planning Q&A digest',
      (initiative.qa ?? []).flatMap((qa) => [`- **Q:** ${qa.question}`, `  **A:** ${qa.answer}`]),
    ),
  )

  return `${lines.join('\n').trimEnd()}\n`
}

/**
 * Deterministically render an initiative into its in-repo tracker files: the
 * canonical `initiative.json` (content view), the human `tracker.md`, and the
 * `version.json` staleness manifest. Pure: same content view → same bytes.
 */
export async function renderInitiativeFiles(
  initiative: Initiative,
  versionMeta: { version: number; generatedAt: string },
): Promise<RenderedFile[]> {
  return [
    { path: initiativeJsonPath(initiative.slug), content: canonicalInitiativeJson(initiative) },
    {
      path: initiativeTrackerPath(initiative.slug),
      content: renderInitiativeTrackerMarkdown(initiative),
    },
    await renderInitiativeVersionFile(initiative, versionMeta),
  ]
}

/** Parse an existing `version.json` (tolerant — a malformed/absent manifest ⇒ null). */
export function parseInitiativeVersionFile(content: string | undefined): InitiativeVersion | null {
  if (!content) return null
  try {
    const parsed = JSON.parse(content) as Partial<InitiativeVersion>
    if (typeof parsed.version !== 'number' || typeof parsed.hash !== 'string') return null
    return {
      version: parsed.version,
      generatedAt: typeof parsed.generatedAt === 'string' ? parsed.generatedAt : '',
      hash: parsed.hash,
      items: typeof parsed.items === 'number' ? parsed.items : 0,
    }
  } catch {
    return null
  }
}

/**
 * Render + commit the initiative tracker onto `branch`, idempotently: the content
 * hash lives in the committed `version.json`, so unchanged content (a re-run, or
 * a durable-driver REPLAY re-entering after the commit landed but before the run
 * state persisted) short-circuits to no commit. Returns the doc bookkeeping to
 * stamp onto `initiative.doc`, or null when nothing changed.
 */
export async function commitInitiativeTracker(
  repo: RepoFiles,
  branch: string,
  initiative: Initiative,
  now: Date,
): Promise<{ version: number; hash: string } | null> {
  const previous = parseInitiativeVersionFile(
    (await repo.getFile(initiativeVersionPath(initiative.slug), branch))?.content,
  )
  const hash = await hashInitiative(initiative)
  if (previous && previous.hash === hash) return null

  const versionMeta = await nextInitiativeVersion(initiative, previous, now)
  const files = await renderInitiativeFiles(initiative, versionMeta)
  await repo.commitFiles({
    branch,
    message: `Update initiative tracker: ${initiative.title}`,
    files,
  })
  return { version: versionMeta.version, hash }
}
