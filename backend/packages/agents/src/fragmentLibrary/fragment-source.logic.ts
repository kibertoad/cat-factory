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
