import type { BlockType } from '../../domain/types'
import type { ConfluenceBoardPlan, PlanFrame, PlanModule, PlanTask } from '../../domain/types'
import { ValidationError } from '../../domain/errors'

// Pure helpers for the Confluence integration: parsing a page id out of user
// input, deriving a plain-text excerpt from storage-format XHTML, the
// deterministic heading-based planner, and coercion of an LLM's JSON into a
// well-formed board plan. Keeping these pure makes the planner deterministic and
// trivially testable without a Confluence site or an LLM.

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
 * Resolve a Confluence page id from raw user input: a bare numeric id, a modern
 * `/wiki/spaces/…/pages/<id>/…` URL, or a legacy `?pageId=<id>` URL.
 */
export function parsePageId(input: string): string | null {
  const trimmed = input.trim()
  if (/^\d+$/.test(trimmed)) return trimmed
  const pageIdParam = trimmed.match(/[?&]pageId=(\d+)/)
  if (pageIdParam) return pageIdParam[1]!
  const pathMatch = trimmed.match(/\/pages\/(?:[a-z-]+\/)?(\d+)/i)
  if (pathMatch) return pathMatch[1]!
  return null
}

/**
 * Reject hostnames that point at the worker's own network rather than a public
 * Confluence Cloud site. The Confluence client fetches `${baseUrl}/wiki/...`
 * with the workspace's Basic-auth credentials, so an unvalidated base URL turns
 * the worker into an SSRF proxy (and leaks the API token to an internal host).
 * This is host-literal defence-in-depth — it does not stop DNS rebinding, but
 * blocks the obvious internal targets (loopback, link-local/metadata, RFC1918).
 */
function isBlockedConfluenceHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host.endsWith('.internal') || host.endsWith('.local')) return true

  // IPv6 loopback / link-local / unique-local.
  if (host === '::1' || host === '::') return true
  if (host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return true

  // IPv4 literal: block loopback, link-local (incl. cloud metadata 169.254.x.x),
  // and the RFC1918 private ranges.
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    if (a === 127 || a === 0 || a === 10) return true
    if (a === 169 && b === 254) return true
    if (a === 192 && b === 168) return true
    if (a === 172 && b >= 16 && b <= 31) return true
  }
  return false
}

/**
 * Validate a (normalized) Confluence base URL before it is stored and later
 * fetched. Requires `https`, forbids embedded credentials, and rejects
 * internal/private hosts. Throws {@link ValidationError} on anything unsafe.
 *
 * Parsed by hand (no `URL` global) so this stays in the platform-agnostic core.
 */
export function assertSafeConfluenceBaseUrl(baseUrl: string): void {
  const invalid = () => new ValidationError(`Confluence base URL is not a valid URL: '${baseUrl}'`)
  const match = baseUrl.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)/)
  if (!match) throw invalid()

  if (match[1]!.toLowerCase() !== 'https') {
    throw new ValidationError('Confluence base URL must use https')
  }
  const authority = match[2]!
  if (authority.includes('@')) {
    throw new ValidationError('Confluence base URL must not contain credentials')
  }
  // Drop an optional `:port`, handling a bracketed IPv6 literal (`[::1]:8443`).
  let host: string
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']')
    if (end === -1) throw invalid()
    host = authority.slice(1, end)
  } else {
    host = authority.split(':')[0]!
  }
  if (host === '') throw invalid()
  if (isBlockedConfluenceHost(host)) {
    throw new ValidationError('Confluence base URL must be a public host')
  }
}

/** Strip tags/entities from storage-format XHTML into collapsed plain text. */
export function htmlToText(html: string): string {
  return html
    .replace(/<\s*(br|\/p|\/h[1-6]|\/li|\/div)\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#3?9;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

/** A short plain-text excerpt of a page body, for list/preview rendering. */
export function buildExcerpt(body: string, max = 280): string {
  const text = htmlToText(body)
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}

interface Heading {
  level: number
  text: string
}

/** Extract h1–h3 headings, in document order, from storage-format XHTML. */
function extractHeadings(body: string): Heading[] {
  const headings: Heading[] = []
  const re = /<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(body)) !== null) {
    const text = htmlToText(m[2]!)
    if (text) headings.push({ level: Number(m[1]), text })
  }
  return headings
}

/**
 * Deterministic fallback planner: map the document's heading outline onto the
 * board. h1 → a service frame, h2 → a module within it, h3 → a task within the
 * current module (or directly in the frame). Used whenever no LLM is configured,
 * and as the safety net when an LLM response can't be parsed.
 */
export function planFromHeadings(pageId: string, title: string, body: string): ConfluenceBoardPlan {
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
  return { pageId, source: 'headings', frames }
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
 * Coerce an LLM's parsed JSON into a well-formed {@link ConfluenceBoardPlan},
 * dropping anything malformed. Returns null when nothing usable remains, so the
 * caller can fall back to the heading parser.
 */
export function coercePlan(pageId: string, parsed: unknown): ConfluenceBoardPlan | null {
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
  return { pageId, source: 'llm', frames }
}
