import type { BlockType, DocumentOrigin, DocumentSourceKind } from '@cat-factory/kernel'
import type { DocumentBoardPlan, PlanFrame, PlanModule, PlanTask } from '@cat-factory/kernel'
import type { DocumentSourceProvider, DocumentSourceRegistry } from '@cat-factory/kernel'
import {
  assertDocumentSourceOAuthAgrees,
  buildExcerpt,
  markdownToText,
  MapSourceRegistry,
} from '@cat-factory/kernel'

// `markdownToText`/`buildExcerpt` now live in the shared markdown helpers (also
// used by the task-source integration); re-exported here so existing
// `documentsLogic.*` consumers are unchanged.
export { buildExcerpt, markdownToText }

// Source-agnostic helpers shared by every document source: deriving a plain-text
// excerpt from a Markdown body, the deterministic heading-based planner, and
// coercion of an LLM's JSON into a well-formed board plan. Providers normalize
// their page bodies to lightweight Markdown so these stay independent of any one
// source's format. Keeping them pure makes the planner deterministic and
// trivially testable without a live source or an LLM.

const BLOCK_TYPES: readonly BlockType[] = [
  'frontend',
  'service',
  'api',
  'database',
  'queue',
  'integration',
  'external',
]

/**
 * The `AppCaches.linkedDocumentVersion` key for one source document, within its workspace group.
 *
 * Lives here, in the folder's pure-logic module, because the READ path
 * (`LinkedDocumentRefreshService`) and the write paths that must drop the entry
 * (`DocumentImportService.import`) are different services: a key built twice is a key that can
 * differ, and an invalidation that targets a key nothing reads fails silently.
 */
export function probeCacheKey(source: DocumentSourceKind, externalId: string): string {
  return `${source}:${externalId}`
}

/** The part of a stored document projection that an agent (or a reader of the board) actually sees. */
export interface AgentVisibleProjection {
  readonly contentHash: string
  readonly title: string
  readonly url: string
}

/**
 * Whether two projections of the same page carry the same thing for a reader.
 *
 * ONE definition, because two callers have to agree about it and they reach opposite conclusions
 * from disagreeing. `DocumentImportService.reimport` uses it to decide whether a fetch is worth a
 * WRITE (and therefore whether `syncedAt`, "when the body was last written", may move);
 * `LinkedDocumentRefreshService` uses it to classify a confirmed check as `reimported` or
 * `revision_only`. A second copy that drifted would render "pulled the newer version" over a row
 * whose bytes the import path had just decided were identical.
 *
 * `sourceVersion` is deliberately NOT part of it. The token is bookkeeping the refresh compares
 * against and no reader ever sees, and the whole point of the `revision_only` verdict is that a
 * moved token with an unmoved body is a real, common state (a Figma file version bumps on any edit
 * in the file). Both callers add their own `sourceVersion` rule around this.
 */
export function sameAgentVisibleProjection(
  a: AgentVisibleProjection,
  b: AgentVisibleProjection,
): boolean {
  return a.contentHash === b.contentHash && a.title === b.title && a.url === b.url
}

/**
 * A trivial in-memory provider registry built from the wired providers.
 *
 * The one construction path for every deployment's document sources, which is why the OAuth
 * half-declaration check sits here rather than in each facade's wiring: a provider that reaches a
 * registry has been through it.
 */
export class MapDocumentSourceRegistry
  extends MapSourceRegistry<DocumentSourceKind, DocumentSourceProvider>
  implements DocumentSourceRegistry
{
  constructor(providers: DocumentSourceProvider[]) {
    super(providers)
    for (const provider of providers) assertDocumentSourceOAuthAgrees(provider)
  }
}

interface Heading {
  level: number
  text: string
}

/** Extract `#`/`##`/`###` headings (clamped to 1–3), in document order. */
function extractHeadings(markdown: string): Heading[] {
  const headings: Heading[] = []
  const re = /^[ \t]*(#{1,6})[ \t]+(.+?)[ \t]*#*$/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(markdown)) !== null) {
    const text = m[2]!.trim()
    if (text) headings.push({ level: Math.min(m[1]!.length, 3), text })
  }
  return headings
}

/**
 * The existing service frame a TARGET-AWARE plan is authored for.
 *
 * `existingModules` is what keeps a targeted plan additive: the planner is told what the frame
 * already holds so it proposes work beside it rather than a second "Checkout" module beside the
 * one that is already there. It is a fact about the board, so the caller reads it; a planner that
 * fetched it would need the block repository for a prompt detail.
 */
export interface PlanTarget {
  frameId: string
  title: string
  type: BlockType
  existingModules: readonly string[]
}

/**
 * Deterministic fallback planner: map the document's heading outline onto the
 * board. h1 → a service frame, h2 → a module within it, h3 → a task within the
 * current module (or directly in the frame). Used whenever no LLM is configured,
 * and as the safety net when an LLM response can't be parsed.
 *
 * With a {@link PlanTarget} it maps onto that ONE frame instead, and the whole outline SHIFTS UP a
 * level: the target occupies the level h1 would have created, so h1 is consumed by it, h2 becomes
 * a module and h3 a task. Keeping h1 as a module would put a module named after the document
 * around everything, one level below the service that is already named after it.
 *
 * A document with SEVERAL h1s therefore loses that top grouping, which is inherent to spawning
 * into one frame rather than a defect of the mapping: a document describing two services is what
 * the board-wide plan is for.
 */
export function planFromHeadings(
  source: DocumentOrigin,
  externalId: string,
  title: string,
  body: string,
  target?: PlanTarget,
): DocumentBoardPlan {
  if (target) return targetedPlanFromHeadings(source, externalId, body, target)
  const headings = extractHeadings(body)
  const frames: PlanFrame[] = []
  let frame: PlanFrame | null = null
  let module: PlanModule | null = null

  const ensureFrame = (): PlanFrame => {
    if (!frame) {
      frame = { type: 'service', title, modules: [], tasks: [] }
      frames.push(frame)
    }
    return frame
  }

  for (const heading of headings) {
    if (heading.level === 1) {
      frame = { type: 'service', title: heading.text, modules: [], tasks: [] }
      frames.push(frame)
      module = null
    } else if (heading.level === 2) {
      module = { name: heading.text, tasks: [] }
      ensureFrame().modules.push(module)
    } else {
      const task: PlanTask = { title: heading.text }
      if (module) module.tasks.push(task)
      else ensureFrame().tasks.push(task)
    }
  }

  if (frames.length === 0) {
    frames.push({ type: 'service', title, modules: [], tasks: [] })
  }
  return { source, externalId, planner: 'headings', targetFrameId: null, frames }
}

/** {@link planFromHeadings} onto one existing frame: h1 is the target, h2 → modules, h3 → tasks. */
function targetedPlanFromHeadings(
  source: DocumentOrigin,
  externalId: string,
  body: string,
  target: PlanTarget,
): DocumentBoardPlan {
  const frame: PlanFrame = { type: target.type, title: target.title, modules: [], tasks: [] }
  let module: PlanModule | null = null
  for (const heading of extractHeadings(body)) {
    if (heading.level === 1) {
      // Consumed by the target, and it also CLOSES the open module: the h2s that follow belong
      // to a new section of the document, so folding them into the previous h1's last module
      // would group work the outline kept apart.
      module = null
    } else if (heading.level === 2) {
      module = { name: heading.text, tasks: [] }
      frame.modules.push(module)
    } else if (module) {
      module.tasks.push({ title: heading.text })
    } else {
      frame.tasks.push({ title: heading.text })
    }
  }
  return { source, externalId, planner: 'headings', targetFrameId: target.frameId, frames: [frame] }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function coerceTask(value: unknown): PlanTask | null {
  if (typeof value !== 'object' || value === null) return null
  const obj = value as Record<string, unknown>
  const title = asString(obj.title)
  if (!title) return null
  const task: PlanTask = { title }
  const description = asString(obj.description)
  if (description) task.description = description
  return task
}

/**
 * Coerce an LLM's parsed JSON into a well-formed {@link DocumentBoardPlan},
 * dropping anything malformed. Returns null when nothing usable remains, so the
 * caller can fall back to the heading parser.
 */
export function coercePlan(
  source: DocumentOrigin,
  externalId: string,
  parsed: unknown,
): DocumentBoardPlan | null {
  const root = parsed as Record<string, unknown> | null
  const rawFrames = Array.isArray(root?.frames) ? root!.frames : []
  const frames: PlanFrame[] = []
  for (const raw of rawFrames) {
    if (typeof raw !== 'object' || raw === null) continue
    const obj = raw as Record<string, unknown>
    const title = asString(obj.title)
    if (!title) continue
    const type = (BLOCK_TYPES as readonly string[]).includes(obj.type as string)
      ? (obj.type as BlockType)
      : 'service'
    const modules: PlanModule[] = []
    for (const rawModule of Array.isArray(obj.modules) ? obj.modules : []) {
      if (typeof rawModule !== 'object' || rawModule === null) continue
      const mod = rawModule as Record<string, unknown>
      const name = asString(mod.name)
      if (!name) continue
      const tasks = (Array.isArray(mod.tasks) ? mod.tasks : [])
        .map(coerceTask)
        .filter((t): t is PlanTask => t !== null)
      modules.push({ name, tasks })
    }
    const tasks = (Array.isArray(obj.tasks) ? obj.tasks : [])
      .map(coerceTask)
      .filter((t): t is PlanTask => t !== null)
    const frame: PlanFrame = { type, title, modules, tasks }
    const description = asString(obj.description)
    if (description) frame.description = description
    frames.push(frame)
  }
  if (frames.length === 0) return null
  return { source, externalId, planner: 'llm', targetFrameId: null, frames }
}

/**
 * Coerce a TARGET-AWARE model response — `{ modules, tasks }` for one existing service — into a
 * plan carrying exactly that frame. Null when nothing usable remains, so the caller falls back to
 * the targeted heading parser rather than to a board-wide plan the user did not ask for.
 *
 * It reads a DIFFERENT top-level shape from {@link coercePlan} because it asked a different
 * question: a targeted prompt that answered with `frames` would be a model proposing an
 * architecture where a service already exists, and quietly re-reading those frames as modules
 * would launder that mistake into the board.
 */
export function coerceTargetedPlan(
  source: DocumentOrigin,
  externalId: string,
  parsed: unknown,
  target: PlanTarget,
): DocumentBoardPlan | null {
  const root = (parsed ?? null) as Record<string, unknown> | null
  const modules: PlanModule[] = []
  for (const raw of Array.isArray(root?.modules) ? root.modules : []) {
    if (typeof raw !== 'object' || raw === null) continue
    const name = asString((raw as Record<string, unknown>).name)
    if (!name) continue
    const tasks = (
      Array.isArray((raw as Record<string, unknown>).tasks)
        ? ((raw as Record<string, unknown>).tasks as unknown[])
        : []
    )
      .map(coerceTask)
      .filter((t): t is PlanTask => t !== null)
    modules.push({ name, tasks })
  }
  const tasks = (Array.isArray(root?.tasks) ? root.tasks : [])
    .map(coerceTask)
    .filter((t): t is PlanTask => t !== null)
  if (modules.length === 0 && tasks.length === 0) return null
  return {
    source,
    externalId,
    planner: 'llm',
    targetFrameId: target.frameId,
    frames: [{ type: target.type, title: target.title, modules, tasks }],
  }
}
