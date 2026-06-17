import type { AgentKind, BlockType } from '@cat-factory/kernel'
import type { FragmentAppliesTo } from '@cat-factory/kernel'

// Pure logic for repo-sourced fragments (ADR 0006 §4): parse one Markdown file
// with YAML frontmatter into a fragment, plus the small helpers the sync flow
// needs (slugging an id from a path, digesting a directory listing for the
// cheap "changed?" check). No I/O lives here so it is unit-testable.

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
 * Stable digest of a source's file listing — sorted `path:sha` pairs hashed with
 * FNV-1a. Stored as the source's `lastSyncedSha`; comparing it against a fresh
 * listing is the cheap change check the resync badge uses, no per-file reads.
 */
export function digestListing(entries: { path: string; sha: string }[]): string {
  const joined = entries
    .map((e) => `${e.path}:${e.sha}`)
    .sort()
    .join('\n')
  // FNV-1a (32-bit), hex. Sufficient for change detection (not cryptographic).
  let hash = 0x811c9dc5
  for (let i = 0; i < joined.length; i++) {
    hash ^= joined.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
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

function splitFrontmatter(content: string): { frontmatter: string; body: string } {
  // Tolerate a leading BOM/whitespace before the opening fence.
  const match = content.match(/^﻿?\s*---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) return { frontmatter: '', body: content }
  return { frontmatter: match[1] ?? '', body: match[2] ?? '' }
}

/** A deliberately small YAML subset: top-level `key: value` and one nested map. */
function parseSimpleYaml(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const lines = text.split(/\r?\n/)
  let nestedKey: string | null = null
  let nested: Record<string, unknown> | null = null
  for (const raw of lines) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue
    const indented = /^\s+/.test(raw)
    const colon = raw.indexOf(':')
    if (colon === -1) continue
    const key = raw.slice(0, colon).trim()
    const value = raw.slice(colon + 1).trim()
    if (indented && nested) {
      nested[key] = parseScalarOrArray(value)
      continue
    }
    if (value === '') {
      // Opens a nested map (e.g. `appliesTo:`).
      nestedKey = key
      nested = {}
      out[key] = nested
    } else {
      nestedKey = null
      nested = null
      out[key] = parseScalarOrArray(value)
    }
  }
  void nestedKey
  return out
}

function parseScalarOrArray(value: string): unknown {
  const inline = value.match(/^\[(.*)\]$/)
  if (inline) {
    return inline[1]!
      .split(',')
      .map((s) => unquote(s.trim()))
      .filter((s) => s.length > 0)
  }
  return unquote(value)
}

function unquote(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1)
  }
  return s
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function strArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean)
  const single = str(value)
  return single ? [single] : []
}

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
