import type { DocumentSourceDescriptor } from '../../domain/types'

// Notion-specific pure logic, kept out of the worker so it is unit-testable
// without a live workspace: parsing/normalizing a page id out of user input, and
// converting Notion block JSON into the lightweight Markdown the generic planner
// consumes. The fetch itself (a single integration token, no per-site base URL —
// so no SSRF surface) lives in the worker's NotionProvider.

/** What the connect UI renders, and which credentials the provider needs. */
export const NOTION_DESCRIPTOR: DocumentSourceDescriptor = {
  source: 'notion',
  label: 'Notion',
  icon: 'i-lucide-notebook-text',
  credentialFields: [
    {
      key: 'apiToken',
      label: 'Internal integration token',
      secret: true,
      placeholder: 'ntn_… or secret_…',
      help: 'Create an internal integration at notion.so/my-integrations, then share each page with it',
    },
  ],
  refLabel: 'Page URL or ID',
  refPlaceholder: 'https://notion.so/Title-abc123…  or  the page id',
}

/** Format 32 hex chars as a canonical dashed Notion/UUID id. */
export function formatNotionId(hex32: string): string {
  const h = hex32.toLowerCase()
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

/**
 * Resolve a Notion page id from raw user input: a bare id (dashed UUID or 32 hex
 * chars), or any Notion URL whose last path segment ends in the id. Returns the
 * canonical dashed id, or null if none is found.
 */
export function parseNotionRef(input: string): string | null {
  // Drop query/hash, then scan for a UUID-shaped (dashes optional) run; the page
  // id is the last such run (workspace URLs may carry a leading slug or id).
  const cleaned = input.trim().split(/[?#]/)[0]!
  const matches = cleaned.match(
    /[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}/g,
  )
  if (!matches || matches.length === 0) return null
  const hex = matches[matches.length - 1]!.replace(/-/g, '')
  if (hex.length !== 32) return null
  return formatNotionId(hex)
}

// ---- Block → Markdown -----------------------------------------------------

interface RichText {
  plain_text?: string
}

/** The subset of a Notion block we read; the type key holds the rich text. */
export interface NotionBlock {
  type?: string
  [key: string]: unknown
}

function richTextOf(block: NotionBlock): string {
  const payload = block.type
    ? (block[block.type] as { rich_text?: RichText[] } | undefined)
    : undefined
  const rich = payload?.rich_text
  if (!Array.isArray(rich)) return ''
  return rich
    .map((r) => r.plain_text ?? '')
    .join('')
    .trim()
}

/**
 * Convert a Notion page's top-level blocks into the lightweight Markdown the
 * generic planner/excerpt logic consumes: headings become `#`/`##`/`###`, list
 * items / to-dos become `- `, and other text blocks become plain lines.
 */
export function notionBlocksToMarkdown(blocks: NotionBlock[]): string {
  const lines: string[] = []
  for (const block of blocks) {
    const text = richTextOf(block)
    switch (block.type) {
      case 'heading_1':
        lines.push(`# ${text}`)
        break
      case 'heading_2':
        lines.push(`## ${text}`)
        break
      case 'heading_3':
        lines.push(`### ${text}`)
        break
      case 'bulleted_list_item':
      case 'numbered_list_item':
      case 'to_do':
        if (text) lines.push(`- ${text}`)
        break
      case 'paragraph':
      case 'quote':
      case 'callout':
      case 'toggle':
      case 'code':
        if (text) lines.push(text)
        break
      default:
        if (text) lines.push(text)
    }
  }
  return lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Extract a page title from a Notion page object's `properties`. */
export function notionPageTitle(properties: Record<string, unknown> | undefined): string {
  if (!properties) return '(untitled)'
  for (const value of Object.values(properties)) {
    const prop = value as { type?: string; title?: RichText[] }
    if (prop?.type === 'title' && Array.isArray(prop.title)) {
      const text = prop.title
        .map((r) => r.plain_text ?? '')
        .join('')
        .trim()
      if (text) return text
    }
  }
  return '(untitled)'
}
