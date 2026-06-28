import type { DocumentSourceDescriptor } from '@cat-factory/kernel'
import { assertHostPinned } from './http.js'

// Claude-Design pure logic, kept out of the provider shell so it is unit-testable
// without a live API: the connect-form descriptor, parsing a project/file ref out of
// user input, the fixed-host SSRF guard, and — the part that earns the provider its
// place over a plain HTML upload — a deterministic **design-system normalizer** that
// turns a Claude Design project's manifest + component-preview HTML into the same
// lightweight Markdown shape the Figma provider emits (`### Components`, `### Design
// tokens`), so a frontend agent reads the design system the same way regardless of
// which tool authored it. The `fetch` itself lives in `ClaudeDesignProvider`.
//
// Why a normalizer and not pass-through: a Claude Design export bundle is raw component
// HTML + CSS. Handed to an agent verbatim it is noise (markup, scripts, inline styles).
// The value is the *structure* — which components exist, grouped how, and what design
// tokens (CSS custom properties) back them. That extraction is deterministic, so it is
// backend TS here, not an LLM step, and it is what distinguishes this provider from
// attaching the same HTML as a generic document.

/**
 * Claude Design's programmatic-read host. PROVISIONAL: today the design-system read is
 * bound to a claude.ai login; this provider targets the per-user-PAT API shape the
 * product is moving toward. The host is pinned (see {@link assertSafeClaudeDesignUrl})
 * and the exact endpoints in `ClaudeDesignProvider` should be re-verified against the
 * current API when the credentialed read ships — treat them as the intended shape, not a
 * frozen contract.
 */
export const CLAUDE_DESIGN_API_HOST = 'api.claude.com'

/** Where a human opens the project (the canonical URL stored on imported documents). */
export const CLAUDE_DESIGN_APP_HOST = 'claude.ai'

/** What the connect UI renders, and which credentials the provider needs. */
export const CLAUDE_DESIGN_DESCRIPTOR: DocumentSourceDescriptor = {
  source: 'claude-design',
  label: 'Claude Design',
  icon: 'i-lucide-palette',
  credentialFields: [
    {
      key: 'apiToken',
      label: 'Personal access token',
      secret: true,
      placeholder: 'sk-ant-…',
      help: 'A Claude Design personal access token authenticates as your own account, so it is stored per user and never shared with the rest of the workspace. Create one in claude.ai → Settings → Design.',
    },
  ],
  refLabel: 'Claude Design project or component URL',
  refPlaceholder: 'https://claude.ai/design/<projectId>',
  // No catalogue search over a PAT — import a specific project/component by URL.
  searchable: false,
  // Personal token: each member connects their own; stored keyed by user id.
  credentialScope: 'user',
}

/**
 * The Claude Design read host is fixed, so any request/redirect must stay on it over
 * https. A redirect off-host (e.g. to a link-local metadata address) is rejected as an
 * SSRF attempt. Delegates to the shared host-pin guard; throws a plain `Error` the
 * provider maps to a `DocumentHttpError`. Kept pure so it is unit-testable without a
 * network.
 */
export function assertSafeClaudeDesignUrl(url: string): void {
  assertHostPinned(url, CLAUDE_DESIGN_API_HOST, 'Claude Design')
}

// ---- Ref parsing + canonical URL ------------------------------------------

/** Composite external id delimiter: `<projectId>` or `<projectId>::<filePath>`. */
const REF_DELIM = '::'

const PROJECT_ID_RE = /^[A-Za-z0-9_-]+$/

/**
 * Resolve a Claude Design reference from raw user input into the stable composite
 * external id this provider stores: `"<projectId>"` for a whole project, or
 * `"<projectId>::<filePath>"` for a single component/file. Accepts a
 * `claude.ai/design/<projectId>` URL (optionally `…/files/<path>` or `?file=<path>`), a
 * bare project id, or the composite form. Returns null when no project id is found.
 *
 * Deterministic (same input → same external id), which the
 * `(workspace, source, externalId)` document key relies on for de-duplication.
 */
export function parseClaudeDesignRef(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  // Bare ref (anything that isn't an absolute URL): a project id, optionally
  // `::`-suffixed with a file path (the path may itself contain `/`). Keyed off the
  // `://` scheme separator so a bare `projectId::path` is never mis-parsed as a URL.
  if (!trimmed.includes('://')) {
    const [projectId, ...rest] = trimmed.split(REF_DELIM)
    if (!projectId || !PROJECT_ID_RE.test(projectId)) return null
    const path = rest.join(REF_DELIM).trim()
    return path ? `${projectId}${REF_DELIM}${normalizeFilePath(path)}` : projectId
  }

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  if (!/(^|\.)claude\.(ai|com)$/i.test(url.hostname)) return null
  const segments = url.pathname.split('/').filter(Boolean)
  const designIdx = segments.indexOf('design')
  if (designIdx === -1 || designIdx + 1 >= segments.length) return null
  const projectId = segments[designIdx + 1]!
  if (!PROJECT_ID_RE.test(projectId)) return null

  // A file path may follow as `…/design/<id>/files/<path…>` or `?file=<path>`.
  const after = segments.slice(designIdx + 2)
  const fileSegments = after[0] === 'files' ? after.slice(1) : after
  const queryFile = url.searchParams.get('file') ?? url.searchParams.get('path')
  const rawPath = queryFile ?? (fileSegments.length ? fileSegments.join('/') : '')
  const path = rawPath ? normalizeFilePath(rawPath) : ''
  return path ? `${projectId}${REF_DELIM}${path}` : projectId
}

/** Strip leading slashes and collapse `.`/empty segments from a file path. */
function normalizeFilePath(path: string): string {
  return path
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s && s !== '.')
    .join('/')
}

/** Split a composite external id back into its project id and optional file path. */
export function splitClaudeDesignExternalId(externalId: string): {
  projectId: string
  filePath?: string
} {
  const idx = externalId.indexOf(REF_DELIM)
  if (idx === -1) return { projectId: externalId }
  const filePath = externalId.slice(idx + REF_DELIM.length)
  return { projectId: externalId.slice(0, idx), filePath: filePath || undefined }
}

/** Build the canonical web URL stored on the imported document (matched by `getByUrl`). */
export function claudeDesignUrlFor(externalId: string): string {
  const { projectId, filePath } = splitClaudeDesignExternalId(externalId)
  const base = `https://${CLAUDE_DESIGN_APP_HOST}/design/${projectId}`
  return filePath ? `${base}/files/${filePath}` : base
}

// ---- Design-system normalizer ---------------------------------------------

/** A single component card, as recorded by Claude Design's `@dsCard` markers/manifest. */
export interface DsCard {
  name?: string
  group?: string
  subtitle?: string
  path?: string
}

/** One fetched project file (path + raw textual content). */
export interface ClaudeDesignFile {
  path: string
  content: string
}

/** The manifest file name Claude Design compiles its card index into. */
export const DS_MANIFEST_PATH = '_ds_manifest.json'

const MAX_CARDS = 200
const MAX_TOKENS = 200
const MAX_TEXT_CHARS = 2000

/**
 * Parse a `_ds_manifest.json` payload (a bare array of cards, or `{ cards: [...] }`)
 * into a lenient {@link DsCard} list. Unknown shapes yield `[]` so the caller falls
 * back to per-file HTML extraction.
 */
export function parseDsManifest(json: unknown): DsCard[] {
  const raw = Array.isArray(json)
    ? json
    : json && typeof json === 'object' && Array.isArray((json as { cards?: unknown }).cards)
      ? (json as { cards: unknown[] }).cards
      : []
  const cards: DsCard[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const card: DsCard = {}
    if (typeof o.name === 'string') card.name = o.name.trim()
    if (typeof o.group === 'string') card.group = o.group.trim()
    if (typeof o.subtitle === 'string') card.subtitle = o.subtitle.trim()
    if (typeof o.path === 'string') card.path = o.path.trim()
    if (card.name || card.path) cards.push(card)
    if (cards.length >= MAX_CARDS) break
  }
  return cards
}

const DS_CARD_RE = /<!--\s*@dsCard\s+([^>]*?)-->/i
const ATTR_RE = /(\w+)\s*=\s*"([^"]*)"/g

/**
 * Read the first-line `<!-- @dsCard group="…" name="…" subtitle="…" -->` marker Claude
 * Design writes at the top of each component-preview HTML. Returns null when absent.
 */
export function parseDsCardComment(html: string): DsCard | null {
  const match = DS_CARD_RE.exec(html)
  if (!match) return null
  const attrs: Record<string, string> = {}
  let m: RegExpExecArray | null
  ATTR_RE.lastIndex = 0
  while ((m = ATTR_RE.exec(match[1]!))) attrs[m[1]!.toLowerCase()] = m[2]!.trim()
  const card: DsCard = {}
  if (attrs.name) card.name = attrs.name
  if (attrs.group) card.group = attrs.group
  if (attrs.subtitle) card.subtitle = attrs.subtitle
  return card.name || card.group ? card : null
}

const CSS_VAR_RE = /(--[A-Za-z0-9_-]+)\s*:\s*([^;{}]+)[;}]/g

/**
 * Extract CSS custom properties (`--token: value`) from a stylesheet/HTML blob as design
 * tokens, deduped (last value wins) and sorted. These are Claude Design's design tokens —
 * the analogue of Figma variables.
 */
export function extractCssTokens(content: string): string[] {
  const tokens = new Map<string, string>()
  let m: RegExpExecArray | null
  CSS_VAR_RE.lastIndex = 0
  while ((m = CSS_VAR_RE.exec(content))) {
    const name = m[1]!
    const value = m[2]!.replace(/\s+/g, ' ').trim()
    if (value && !value.startsWith('var(')) tokens.set(name, value)
    if (tokens.size >= MAX_TOKENS) break
  }
  return [...tokens.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k} = ${v}`)
}

/** Strip `<script>`/`<style>` blocks and all tags, returning collapsed visible text. */
export function htmlToText(html: string): string {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}…` : text
}

/** Render a grouped component inventory from a card list (`### <group>` → `- <name>`). */
export function dsCardsToMarkdown(cards: DsCard[]): string {
  const byGroup = new Map<string, DsCard[]>()
  for (const card of cards) {
    if (!card.name && !card.path) continue
    const group = card.group?.trim() || 'Components'
    const list = byGroup.get(group) ?? []
    list.push(card)
    byGroup.set(group, list)
  }
  if (byGroup.size === 0) return ''
  const lines: string[] = ['### Components']
  for (const group of [...byGroup.keys()].sort()) {
    lines.push(`#### ${group}`)
    const seen = new Set<string>()
    for (const card of byGroup.get(group)!) {
      const name = card.name?.trim() || card.path?.trim() || '(unnamed)'
      if (seen.has(name)) continue
      seen.add(name)
      lines.push(card.subtitle ? `- ${name} — ${card.subtitle}` : `- ${name}`)
    }
  }
  return lines.join('\n')
}

/**
 * Normalize a whole Claude Design project's fetched files into the lightweight Markdown a
 * frontend agent consumes. Strategy:
 *   1. If a `_ds_manifest.json` is present, it is the authoritative component index →
 *      `### Components` grouped inventory.
 *   2. Otherwise, recover the inventory from each preview HTML's `@dsCard` marker.
 *   3. Design tokens are unioned from the CSS custom properties across all files.
 *   4. A bounded slice of visible text gives the agent a sense of the content.
 *
 * `projectName` titles the document. Pure: no network, fully unit-testable.
 */
export function renderClaudeDesignProject(projectName: string, files: ClaudeDesignFile[]): string {
  const manifest = files.find((f) => f.path.endsWith(DS_MANIFEST_PATH))
  let cards: DsCard[] = []
  if (manifest) {
    try {
      cards = parseDsManifest(JSON.parse(manifest.content))
    } catch {
      cards = []
    }
  }
  const htmlFiles = files.filter((f) => /\.html?$/i.test(f.path))
  if (cards.length === 0) {
    for (const file of htmlFiles) {
      const card = parseDsCardComment(file.content)
      if (card) cards.push({ ...card, path: file.path })
    }
  }

  const tokenSet = new Map<string, string>()
  for (const file of files) {
    if (file.path.endsWith(DS_MANIFEST_PATH)) continue
    for (const entry of extractCssTokens(file.content)) {
      const eq = entry.indexOf(' = ')
      tokenSet.set(entry.slice(0, eq), entry.slice(eq + 3))
      if (tokenSet.size >= MAX_TOKENS) break
    }
  }

  const sections: string[] = [`## ${projectName.trim() || 'Claude Design project'}`]
  const inventory = dsCardsToMarkdown(cards)
  if (inventory) sections.push(inventory)

  if (tokenSet.size) {
    const tokenLines = [...tokenSet.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `- ${k} = ${v}`)
    sections.push(['### Design tokens', ...tokenLines].join('\n'))
  }

  // A single-component import (one HTML, no manifest) carries little structure, so fold in
  // a slice of its visible text — the same text-content affordance the Figma renderer gives.
  if (!manifest && htmlFiles.length === 1) {
    const text = htmlToText(htmlFiles[0]!.content)
    if (text) sections.push(['### Content', text].join('\n'))
  }

  return sections.join('\n\n').trim()
}
