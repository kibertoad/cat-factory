import type { DocumentSourceDescriptor } from '@cat-factory/kernel'
import {
  dimensionMeta,
  type DesignBlock,
  type DesignComponent,
  type DesignContext,
  type DesignToken,
} from './design.logic.js'
import { assertHostPinned } from './http.js'

// Figma-specific pure logic, kept out of the provider shell so it is unit-testable
// without a live workspace: parsing/canonicalising a file+node ref out of user input,
// the fixed-host SSRF guard, and converting the Figma node/variables JSON into the
// lightweight Markdown the generic planner + `.cat-context/` materialisation consume.
// The `fetch` itself (the `X-Figma-Token` REST client) lives in `FigmaProvider`.

/** Figma's REST API host. The PAT is sent to this host only — see {@link assertSafeFigmaUrl}. */
export const FIGMA_API_HOST = 'api.figma.com'

/** What the connect UI renders, and which credentials the provider needs. */
export const FIGMA_DESCRIPTOR: DocumentSourceDescriptor = {
  source: 'figma',
  label: 'Figma',
  icon: 'i-lucide-figma',
  credentialFields: [
    {
      key: 'apiToken',
      label: 'Personal access token',
      secret: true,
      placeholder: 'figd_…',
      help: 'Create a personal access token at figma.com → Settings → Security → Personal access tokens (file_content + file_variables read scopes). Design tokens require an Enterprise plan; without it the tokens section is simply omitted.',
    },
  ],
  refLabel: 'Figma file or frame URL',
  refPlaceholder: 'https://www.figma.com/design/<key>/Title?node-id=1-2',
  // No catalogue search API for a PAT — import a specific file/frame by URL.
  searchable: false,
}

/**
 * The Figma REST host is fixed, so any request/redirect must stay on
 * `api.figma.com` over https. A redirect off-host (e.g. to an internal address)
 * is treated as an SSRF attempt and rejected. Mirrors the per-hop guard the other
 * document providers run. Throws a plain `Error` (the provider maps it to a
 * `FigmaApiError`); kept pure so it is unit-testable without a network.
 */
export function assertSafeFigmaUrl(url: string): void {
  assertHostPinned(url, FIGMA_API_HOST, 'Figma')
}

// ---- Ref parsing + canonical URL ------------------------------------------

/**
 * Normalise a Figma node id to the API/colon form. Figma share URLs encode a
 * node id as `1234-5678` (dash) where the REST API expects `1234:5678` (colon);
 * a `?node-id=1234%3A5678` decodes straight to the colon form. We accept either
 * and return the colon form, or null for anything that isn't a simple
 * `n` / `n:n` node id (complex instance ids like `I12:3;45:6` are dropped → the
 * import falls back to the whole file rather than guessing).
 */
export function normalizeFigmaNodeId(raw: string): string | null {
  const value = raw.trim()
  if (!value) return null
  const colon = value.includes(':') ? value : value.replace(/-/g, ':')
  if (/^\d+:\d+$/.test(colon) || /^\d+$/.test(colon)) return colon
  return null
}

/**
 * Resolve a Figma reference from raw user input into the stable composite
 * external id this provider stores: `"<fileKey>"` for a whole-file link, or
 * `"<fileKey>:<nodeId>"` for a specific frame/node (nodeId in colon form).
 * Accepts a `figma.com` file/design/proto/board URL, a bare file key, or a
 * `fileKey:node:id` string. Returns null when no file key is found.
 *
 * `parseRef` is deterministic (same input → same external id), which is what the
 * `(workspace, source, externalId)` document key relies on for de-duplication —
 * URL auto-match via `getByUrl` is a separate, best-effort path keyed on the
 * canonical {@link figmaUrlFor} output.
 */
export function parseFigmaRef(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  // Bare ref: a file key, optionally `:`-suffixed with a node id. Only when it is
  // clearly not a URL (no scheme, no slash, not a figma.com host).
  if (!trimmed.includes('/') && !/figma\.com/i.test(trimmed)) {
    const [key, ...rest] = trimmed.split(':')
    if (!key || !/^[A-Za-z0-9]+$/.test(key)) return null
    if (rest.length === 0) return key
    const node = normalizeFigmaNodeId(rest.join(':'))
    return node ? `${key}:${node}` : key
  }

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  if (!/(^|\.)figma\.com$/i.test(url.hostname)) return null
  const match = url.pathname.match(/\/(?:file|design|proto|board)\/([A-Za-z0-9]+)/)
  if (!match) return null
  const fileKey = match[1]!
  const nodeRaw = url.searchParams.get('node-id')
  if (!nodeRaw) return fileKey
  const node = normalizeFigmaNodeId(nodeRaw)
  return node ? `${fileKey}:${node}` : fileKey
}

/** Split a composite external id back into its file key and optional node id (colon form). */
export function splitFigmaExternalId(externalId: string): { fileKey: string; nodeId?: string } {
  const idx = externalId.indexOf(':')
  if (idx === -1) return { fileKey: externalId }
  return { fileKey: externalId.slice(0, idx), nodeId: externalId.slice(idx + 1) }
}

/**
 * Build the canonical web URL stored on the imported document (and matched by
 * `getByUrl`). The node id is rendered back in the share-URL dash form so the
 * stored URL matches the kind of link a teammate pastes into a task description.
 */
export function figmaUrlFor(externalId: string): string {
  const { fileKey, nodeId } = splitFigmaExternalId(externalId)
  const base = `https://www.figma.com/design/${fileKey}`
  if (!nodeId) return base
  return `${base}?node-id=${nodeId.replace(/:/g, '-')}`
}

// ---- Node tree → DesignContext --------------------------------------------

/** The subset of a Figma node we read for the layout/text/component rendering. */
export interface FigmaNode {
  id?: string
  name?: string
  type?: string
  characters?: string
  componentId?: string
  absoluteBoundingBox?: { width?: number; height?: number } | null
  children?: FigmaNode[]
}

/** A `componentId → { name }` map (Figma returns it alongside the node tree). */
export interface FigmaComponentMap {
  [id: string]: { name?: string } | undefined
}

const MAX_TREE_DEPTH = 6
const MAX_TREE_NODES = 400

function dimensionLabel(node: FigmaNode): string {
  return dimensionMeta(node.absoluteBoundingBox?.width, node.absoluteBoundingBox?.height) ?? ''
}

/**
 * Render a node and its descendants as an indented bullet tree (name + type +
 * size), bounded in depth and total nodes so a huge frame can't blow up the
 * context file. Mutates `counter` to enforce the global node cap.
 */
function renderLayout(
  node: FigmaNode,
  depth: number,
  counter: { n: number },
  lines: string[],
): void {
  if (depth > MAX_TREE_DEPTH || counter.n >= MAX_TREE_NODES) return
  counter.n++
  const indent = '  '.repeat(depth)
  const name = node.name?.trim() || '(unnamed)'
  const type = node.type ? ` _${node.type}_` : ''
  lines.push(`${indent}- ${name}${type}${dimensionLabel(node)}`)
  for (const child of node.children ?? []) {
    if (counter.n >= MAX_TREE_NODES) {
      lines.push(`${indent}  - … (truncated)`)
      break
    }
    renderLayout(child, depth + 1, counter, lines)
  }
}

/** Collect every TEXT node's `characters`, in document order, bounded. */
function collectText(node: FigmaNode, out: string[]): void {
  if (out.length >= MAX_TREE_NODES) return
  if (node.type === 'TEXT' && node.characters?.trim()) out.push(node.characters.trim())
  for (const child of node.children ?? []) collectText(child, out)
}

/** Collect the distinct design-system components a node tree instantiates. */
function collectComponents(node: FigmaNode, components: FigmaComponentMap, out: Set<string>): void {
  if (node.type === 'INSTANCE') {
    const name = (node.componentId && components[node.componentId]?.name) || node.name?.trim()
    if (name) out.add(name)
  }
  for (const child of node.children ?? []) collectComponents(child, components, out)
}

/**
 * Map the fetched Figma frames into the source-neutral {@link DesignBlock}s: one block
 * per frame, with a `Layout` bullet tree and the frame's `Text content`. The
 * design-system components are collected separately ({@link figmaComponents}) into the
 * shared global `### Components` section rather than per-frame.
 */
export function figmaBlocks(roots: FigmaNode[]): DesignBlock[] {
  return roots.map((root) => {
    const layout: string[] = []
    // One counter shared across every top-level child so MAX_TREE_NODES bounds the whole
    // frame, not each subtree — a wide frame can't blow past the cap one branch at a time.
    const counter = { n: 0 }
    for (const child of root.children ?? []) renderLayout(child, 0, counter, layout)

    const text: string[] = []
    collectText(root, text)

    return {
      title: root.name?.trim() || '(unnamed frame)',
      meta: dimensionLabel(root),
      sections: [
        { heading: 'Layout', lines: layout },
        { heading: 'Text content', lines: text.map((t) => `- ${t.replace(/\s+/g, ' ')}`) },
      ],
    }
  })
}

/** Collect the distinct design-system components instantiated across the frames. */
export function figmaComponents(
  roots: FigmaNode[],
  components: FigmaComponentMap = {},
): DesignComponent[] {
  const names = new Set<string>()
  for (const root of roots) collectComponents(root, components, names)
  return [...names].map((name) => ({ name }))
}

// ---- Variables → DesignToken[] --------------------------------------------

interface FigmaVariable {
  name?: string
  resolvedType?: string
  variableCollectionId?: string
  valuesByMode?: Record<string, unknown>
}

interface FigmaVariableCollection {
  name?: string
  modes?: { modeId?: string; name?: string }[]
}

/** The `/v1/files/:key/variables/local` `meta` payload we read. */
export interface FigmaVariablesMeta {
  variables?: Record<string, FigmaVariable | undefined>
  variableCollections?: Record<string, FigmaVariableCollection | undefined>
}

/** Render a single variable value (colour object → hex/rgba, else compact JSON). */
function renderVariableValue(value: unknown): string {
  if (value && typeof value === 'object' && 'r' in (value as Record<string, unknown>)) {
    const c = value as { r: number; g: number; b: number; a?: number }
    const to255 = (n: number) => Math.round((n ?? 0) * 255)
    const hex = [c.r, c.g, c.b].map((n) => to255(n).toString(16).padStart(2, '0')).join('')
    return c.a != null && c.a < 1 ? `#${hex} (a=${c.a.toFixed(2)})` : `#${hex}`
  }
  if (value && typeof value === 'object' && 'type' in (value as Record<string, unknown>)) {
    // An alias to another variable — surface its target id.
    const alias = value as { type?: string; id?: string }
    if (alias.type === 'VARIABLE_ALIAS' && alias.id) return `→ ${alias.id}`
  }
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(2)
  if (typeof value === 'string' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

/**
 * Map the Figma local-variables payload into source-neutral {@link DesignToken}s
 * (`collection › mode › name = value`). Empty when there are no variables, so the
 * shared renderer drops the `### Design tokens` section entirely.
 */
export function figmaTokens(meta: FigmaVariablesMeta | undefined | null): DesignToken[] {
  const variables = meta?.variables ?? {}
  const collections = meta?.variableCollections ?? {}
  const tokens: DesignToken[] = []
  for (const variable of Object.values(variables)) {
    if (!variable?.name) continue
    const collection = variable.variableCollectionId
      ? collections[variable.variableCollectionId]
      : undefined
    const collectionName = collection?.name ?? 'Tokens'
    const modes = collection?.modes ?? []
    for (const [modeId, value] of Object.entries(variable.valuesByMode ?? {})) {
      const modeName = modes.find((m) => m.modeId === modeId)?.name ?? 'default'
      tokens.push({
        collection: collectionName,
        mode: modeName,
        name: variable.name,
        value: renderVariableValue(value),
      })
    }
  }
  return tokens
}

// ---- Assemble the DesignContext -------------------------------------------

export interface FigmaContextInput {
  /** The composite external id (`<fileKey>` or `<fileKey>:<nodeId>`). */
  externalId: string
  /** The Figma file's name (from the API), used for the document title. */
  fileName: string
  /** The frame/node id when this is a node link (drives the title shape). */
  nodeId?: string
  /** The fetched frame roots. */
  roots: FigmaNode[]
  /** The `componentId → { name }` map returned alongside the nodes. */
  components: FigmaComponentMap
  /** Local-variables payload, or null when the plan doesn't expose it. */
  variablesMeta?: FigmaVariablesMeta | null
  /** Best-effort short-lived rendered-preview URL, or null. */
  previewUrl?: string | null
}

/** Assemble the fetched Figma pieces into the shared {@link DesignContext}. */
export function buildFigmaDesignContext(input: FigmaContextInput): DesignContext {
  const { fileKey } = splitFigmaExternalId(input.externalId)
  const title = input.nodeId
    ? `${input.fileName || fileKey} — ${input.roots[0]?.name?.trim() || input.nodeId}`
    : input.fileName || fileKey
  return {
    title,
    url: figmaUrlFor(input.externalId),
    blocks: figmaBlocks(input.roots),
    components: figmaComponents(input.roots, input.components),
    tokens: figmaTokens(input.variablesMeta),
    references: input.previewUrl ? [{ label: 'Rendered preview', url: input.previewUrl }] : [],
  }
}
