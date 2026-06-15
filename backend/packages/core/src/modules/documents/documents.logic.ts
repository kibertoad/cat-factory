import type { BlockType, DocumentSourceKind } from '../../domain/types'
import type { DocumentBoardPlan, PlanFrame, PlanModule, PlanTask } from '../../domain/types'
import type { DocumentSourceProvider, DocumentSourceRegistry } from '../../ports/document-source'

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

/** A trivial in-memory provider registry built from the wired providers. */
export class MapDocumentSourceRegistry implements DocumentSourceRegistry {
  private readonly byKind: Map<DocumentSourceKind, DocumentSourceProvider>

  constructor(providers: DocumentSourceProvider[]) {
    this.byKind = new Map(providers.map((p) => [p.kind, p]))
  }

  get(kind: DocumentSourceKind): DocumentSourceProvider | undefined {
    return this.byKind.get(kind)
  }

  list(): DocumentSourceProvider[] {
    return [...this.byKind.values()]
  }
}

/** Strip lightweight Markdown markers into collapsed plain text. */
export function markdownToText(markdown: string): string {
  return markdown
    .replace(/`{1,3}/g, '')
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]*[-*+][ \t]+/gm, '')
    .replace(/[*_~>]/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

/** A short plain-text excerpt of a Markdown body, for list/preview rendering. */
export function buildExcerpt(markdown: string, max = 280): string {
  const text = markdownToText(markdown)
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
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
 * Deterministic fallback planner: map the document's heading outline onto the
 * board. h1 → a service frame, h2 → a module within it, h3 → a task within the
 * current module (or directly in the frame). Used whenever no LLM is configured,
 * and as the safety net when an LLM response can't be parsed.
 */
export function planFromHeadings(
  source: DocumentSourceKind,
  externalId: string,
  title: string,
  body: string,
): DocumentBoardPlan {
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
  return { source, externalId, planner: 'headings', frames }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function coerceTask(value: unknown): PlanTask | null {
  if (typeof value !== 'object' || value === null) return null
  const obj = value as Record<string, unknown>
  const title = asString(obj.title)
  if (!title) return null
  const features = Array.isArray(obj.features)
    ? obj.features.map(asString).filter((f): f is string => !!f)
    : undefined
  const task: PlanTask = { title }
  const description = asString(obj.description)
  if (description) task.description = description
  if (features && features.length) task.features = features
  return task
}

/**
 * Coerce an LLM's parsed JSON into a well-formed {@link DocumentBoardPlan},
 * dropping anything malformed. Returns null when nothing usable remains, so the
 * caller can fall back to the heading parser.
 */
export function coercePlan(
  source: DocumentSourceKind,
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
  return { source, externalId, planner: 'llm', frames }
}
