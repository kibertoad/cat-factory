import { MAX_FRAGMENT_ID_LENGTH } from '@cat-factory/contracts'
import type { AgentKind, BlockType } from '@cat-factory/kernel'
import type { FragmentAppliesTo } from '@cat-factory/kernel'
import { parseSimpleYaml, splitFrontmatter, str, strArray } from '../repoSourceSync/frontmatter.js'

// Pure logic for repo-sourced fragments (ADR 0006 §4): parse one Markdown file
// with YAML frontmatter into a fragment, plus the small helpers the sync flow
// needs (slugging an id from a path, recognising Markdown files). The generic
// frontmatter split + small-YAML parse are shared with the skill library
// (repoSourceSync/frontmatter). No I/O lives here so it is unit-testable.

const BLOCK_TYPES: readonly string[] = [
  'frontend',
  'service',
  'api',
  'database',
  'queue',
  'integration',
  'external',
  'environment',
]

/** A fragment parsed from a Markdown file's frontmatter + body. */
export interface ParsedFragmentFile {
  /** Explicit id from frontmatter (used to *shadow* a built-in); else undefined. */
  id?: string
  title: string
  category?: string
  summary: string
  body: string
  /**
   * The file's linked SHORT version (`brief:` frontmatter), folded for implementer kinds
   * in place of the body. Absent ⇒ a body over the size threshold is condensed
   * automatically; teams that already keep a terse restatement of a guideline link it here
   * rather than having one synthesized.
   */
  brief?: string
  tags?: string[]
  appliesTo?: FragmentAppliesTo
}

/** Slugify a repo file path into a stable, id-safe token (e.g. `backend/err.md` → `backend-err`). */
export function slugFromPath(path: string): string {
  return (
    path
      .replace(/\.md$/i, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'fragment'
  )
}

/** Whether a listing entry is a Markdown file we should parse. */
export function isMarkdownFile(name: string): boolean {
  return /\.md$/i.test(name)
}

/** Digest length the truncating branch of {@link mintSourcedFragmentId} reserves: `-` + 8 hex. */
const PATH_DIGEST_CHARS = 9

/**
 * The id a repo-sourced file gets when it declares none: `src:<sourceId>:<slug>`, namespaced so
 * two sources cannot collide (an explicit frontmatter `id` instead SHADOWS a built-in, ADR 0006).
 *
 * Bounded by {@link MAX_FRAGMENT_ID_LENGTH}, which is what keeps the id the public catalog
 * publishes one the public create can name back. A deep directory of guidelines reaches that
 * ceiling on ordinary paths, so the over-long case truncates the slug and appends a digest of the
 * whole of it: truncation ALONE would be the wrong shape here, because sibling files in a deep tree
 * share their leading path and differ in the filename, which is exactly the half a prefix cut
 * throws away. The prefix is `src:` plus a minted source id (~36 chars), so the readable head keeps
 * the bulk of the budget.
 */
export function mintSourcedFragmentId(sourceId: string, path: string): string {
  const prefix = `src:${sourceId}:`
  const slug = slugFromPath(path)
  if (prefix.length + slug.length <= MAX_FRAGMENT_ID_LENGTH) return prefix + slug
  const head = slug.slice(0, MAX_FRAGMENT_ID_LENGTH - prefix.length - PATH_DIGEST_CHARS)
  return `${prefix}${head}-${digest(slug)}`
}

/** FNV-1a/32 as 8 hex chars: a stable, dependency-free disambiguator, never a security claim. */
function digest(value: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * Parse a Markdown guideline file. Frontmatter is the leading `--- … ---` block
 * (a small YAML subset: `key: value`, inline `[a, b]` arrays, and nested
 * `appliesTo`). Tolerant: a missing title defaults to a humanised filename, a
 * missing summary to the first body line, so a sparse file still imports.
 * Returns null only when there is no usable body at all.
 */
export function parseFragmentMarkdown(path: string, content: string): ParsedFragmentFile | null {
  const { frontmatter, body } = splitFrontmatter(content)
  const fm = parseSimpleYaml(frontmatter)
  const trimmedBody = body.trim()

  const fallbackTitle = humanise(path)
  const title = str(fm.title) ?? fallbackTitle
  const summary = str(fm.summary) ?? firstLine(trimmedBody) ?? title
  if (!trimmedBody && !summary) return null

  const appliesTo = parseAppliesTo(fm.appliesTo)
  const parsed: ParsedFragmentFile = {
    title,
    summary,
    body: trimmedBody || summary,
  }
  const id = str(fm.id)
  if (id) parsed.id = id
  const brief = str(fm.brief)
  if (brief) parsed.brief = brief
  const category = str(fm.category)
  if (category) parsed.category = category
  const tags = strArray(fm.tags)
  if (tags.length) parsed.tags = tags
  if (appliesTo) parsed.appliesTo = appliesTo
  return parsed
}

// --- internals ------------------------------------------------------------

function parseAppliesTo(value: unknown): FragmentAppliesTo | undefined {
  if (!value || typeof value !== 'object') return undefined
  const obj = value as Record<string, unknown>
  const blockTypes = strArray(obj.blockTypes).filter((t): t is BlockType => BLOCK_TYPES.includes(t))
  const agentKinds = strArray(obj.agentKinds) as AgentKind[]
  const out: FragmentAppliesTo = {}
  if (blockTypes.length) out.blockTypes = blockTypes
  if (agentKinds.length) out.agentKinds = agentKinds
  return out.blockTypes || out.agentKinds ? out : undefined
}

function firstLine(body: string): string | undefined {
  const line = body
    .split(/\r?\n/)
    .map((l) => l.replace(/^[#>\-*\s]+/, '').trim())
    .find((l) => l.length > 0)
  return line ? line.slice(0, 200) : undefined
}

function humanise(path: string): string {
  const base = path.split('/').pop() ?? path
  const stem = base.replace(/\.md$/i, '').replace(/[-_]+/g, ' ').trim()
  return stem ? stem.charAt(0).toUpperCase() + stem.slice(1) : 'Fragment'
}
