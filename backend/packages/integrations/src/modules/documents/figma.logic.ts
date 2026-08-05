import type { DocumentSourceDescriptor } from '@cat-factory/kernel'
import {
  dimensionMeta,
  type DesignBlock,
  type DesignComponent,
  type DesignContext,
  type DesignToken,
  type DesignTokenOrigin,
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

/** A Figma paint (a fill or a stroke). Only a SOLID paint carries a colour we can name. */
export interface FigmaPaint {
  type?: string
  visible?: boolean
  opacity?: number
  color?: { r?: number; g?: number; b?: number; a?: number } | null
}

/** The `style` block Figma puts on a TEXT node: the typography facts we render. */
export interface FigmaTypeStyle {
  fontFamily?: string
  fontWeight?: number
  fontSize?: number
  lineHeightPx?: number
}

/** A component instance's property assignments (`{ 'Size#1:0': { value, type } }`). */
export interface FigmaComponentProperties {
  [name: string]: { value?: unknown; type?: string } | undefined
}

/** The subset of a Figma node we read for the layout/text/component/styling rendering. */
export interface FigmaNode {
  id?: string
  name?: string
  type?: string
  characters?: string
  componentId?: string
  absoluteBoundingBox?: { width?: number; height?: number } | null
  children?: FigmaNode[]
  fills?: FigmaPaint[]
  strokes?: FigmaPaint[]
  style?: FigmaTypeStyle
  cornerRadius?: number
  rectangleCornerRadii?: number[]
  layoutMode?: string
  itemSpacing?: number
  paddingTop?: number
  paddingRight?: number
  paddingBottom?: number
  paddingLeft?: number
  /** Published-style ids by role (`fill`, `text`, `stroke`, `effect`, `grid`). */
  styles?: Record<string, string | undefined>
  componentProperties?: FigmaComponentProperties
}

/** A `componentId → { name }` map (Figma returns it alongside the node tree). */
export interface FigmaComponentMap {
  [id: string]: { name?: string; description?: string; componentSetId?: string } | undefined
}

/** A `componentSetId → { name }` map: the identity a variant's own name does not carry. */
export interface FigmaComponentSetMap {
  [id: string]: { name?: string; description?: string } | undefined
}

/** The file/nodes response `styles` map: a published style id → its metadata. */
export interface FigmaStyleMap {
  [id: string]: { name?: string; styleType?: string; description?: string } | undefined
}

const MAX_TREE_DEPTH = 6
/** Nodes rendered for one frame. */
const MAX_FRAME_NODES = 400
/** Nodes rendered across the WHOLE import: a whole-file import fans out over many frames. */
const MAX_IMPORT_NODES = 1500
/** Text lines collected for one frame, and across the whole import. */
const MAX_FRAME_TEXT = 200
const MAX_IMPORT_TEXT = 600
/** Top-level frames a whole-file import fetches as subtrees. */
export const MAX_FILE_FRAMES = 12
/** Distinct variants listed on one component's note before the rest are summarised away. */
const MAX_VARIANTS_PER_COMPONENT = 6

/** Page children worth fetching as a frame subtree; a stray vector or sticky is not one. */
const FRAME_TYPES = new Set(['FRAME', 'COMPONENT', 'COMPONENT_SET', 'SECTION', 'GROUP'])

function dimensionLabel(node: FigmaNode): string {
  return dimensionMeta(node.absoluteBoundingBox?.width, node.absoluteBoundingBox?.height) ?? ''
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

// ---- Styling facts ---------------------------------------------------------

/** Figma's 0–1 colour channels → `#rrggbb`, with an alpha qualifier below full opacity. */
export function figmaColorHex(
  color: { r?: number; g?: number; b?: number; a?: number } | null | undefined,
  paintOpacity?: number,
): string | null {
  if (!color) return null
  const to2 = (n: number | undefined) =>
    Math.max(0, Math.min(255, Math.round((n ?? 0) * 255)))
      .toString(16)
      .padStart(2, '0')
  const hex = `#${to2(color.r)}${to2(color.g)}${to2(color.b)}`
  const alpha = (color.a ?? 1) * (paintOpacity ?? 1)
  return alpha < 1 ? `${hex} (a=${alpha.toFixed(2)})` : hex
}

/** The first visible SOLID paint's hex, or null when the node has none we can name. */
function firstSolidHex(paints: FigmaPaint[] | undefined): string | null {
  for (const paint of paints ?? []) {
    if (paint.visible === false || paint.type !== 'SOLID') continue
    const hex = figmaColorHex(paint.color, paint.opacity)
    if (hex) return hex
  }
  return null
}

/** `Inter 16/600 lh 24`: the typography an implementer would otherwise have to guess. */
function typographyLabel(style: FigmaTypeStyle | undefined): string | null {
  if (!style) return null
  const parts: string[] = []
  if (style.fontFamily?.trim()) parts.push(style.fontFamily.trim())
  if (style.fontSize != null) {
    parts.push(
      style.fontWeight != null
        ? `${round(style.fontSize)}/${style.fontWeight}`
        : `${round(style.fontSize)}px`,
    )
  } else if (style.fontWeight != null) {
    parts.push(`w${style.fontWeight}`)
  }
  if (style.lineHeightPx != null) parts.push(`lh ${round(style.lineHeightPx)}`)
  return parts.length ? parts.join(' ') : null
}

/** `padding 16` when uniform, else the CSS-ordered `padding 16/24/16/24` (top right bottom left). */
function paddingLabel(node: FigmaNode): string | null {
  const sides = [node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft]
  if (sides.every((s) => s == null)) return null
  const values = sides.map((s) => round(s ?? 0))
  if (values.every((v) => v === values[0])) {
    return values[0] === 0 ? null : `padding ${values[0]}`
  }
  return `padding ${values.join('/')}`
}

function cornerRadiusLabel(node: FigmaNode): string | null {
  const corners = node.rectangleCornerRadii
  if (corners?.length === 4 && corners.some((c) => c !== corners[0])) {
    return `radius ${corners.map((c) => round(c)).join('/')}`
  }
  const radius = node.cornerRadius ?? corners?.[0]
  return radius ? `radius ${round(radius)}` : null
}

function autoLayoutLabel(node: FigmaNode): string | null {
  const mode = node.layoutMode
  if (!mode || mode === 'NONE') return null
  const parts = [`auto-layout ${mode.toLowerCase()}`]
  if (node.itemSpacing) parts.push(`gap ${round(node.itemSpacing)}`)
  const padding = paddingLabel(node)
  if (padding) parts.push(padding)
  return parts.join(' ')
}

/**
 * The styling clause appended to a node's layout line. Everything here is a fact the agent
 * would otherwise invent: the colour, the type ramp, the radius, and the auto-layout that
 * decides whether the implementation is a flex row or a stack.
 */
export function figmaStylingFacts(node: FigmaNode): string[] {
  const facts: string[] = []
  const fill = firstSolidHex(node.fills)
  if (fill) facts.push(`fill ${fill}`)
  const stroke = firstSolidHex(node.strokes)
  if (stroke) facts.push(`stroke ${stroke}`)
  const typography = typographyLabel(node.style)
  if (typography) facts.push(typography)
  const radius = cornerRadiusLabel(node)
  if (radius) facts.push(radius)
  const layout = autoLayoutLabel(node)
  if (layout) facts.push(layout)
  return facts
}

// ---- Layout + text rendering ----------------------------------------------

/** What one import may still spend, shared across every frame it renders. */
interface ImportBudget {
  nodes: number
  text: number
}

/**
 * Render a node and its descendants as an indented bullet tree (name, type, size, styling),
 * bounded in depth and in nodes so a huge frame can't blow up the context file. Returns
 * false when a cap stopped the walk, so the caller can state the frame was cut rather than
 * let a capped tree read as a complete one.
 */
function renderLayout(
  node: FigmaNode,
  depth: number,
  frame: { nodes: number },
  budget: ImportBudget,
  lines: string[],
): boolean {
  if (depth > MAX_TREE_DEPTH) return false
  if (frame.nodes <= 0 || budget.nodes <= 0) return false
  frame.nodes--
  budget.nodes--
  const indent = '  '.repeat(depth)
  const name = node.name?.trim() || '(unnamed)'
  const type = node.type ? ` _${node.type}_` : ''
  const facts = figmaStylingFacts(node)
  const styling = facts.length ? ` [${facts.join('; ')}]` : ''
  lines.push(`${indent}- ${name}${type}${dimensionLabel(node)}${styling}`)
  let complete = true
  for (const child of node.children ?? []) {
    if (!renderLayout(child, depth + 1, frame, budget, lines)) {
      lines.push(`${indent}  - … (truncated)`)
      complete = false
      break
    }
  }
  return complete
}

/** Collect every TEXT node's `characters`, in document order, bounded per frame and import. */
function collectText(node: FigmaNode, budget: ImportBudget, out: string[]): void {
  if (out.length >= MAX_FRAME_TEXT || budget.text <= 0) return
  if (node.type === 'TEXT' && node.characters?.trim()) {
    out.push(node.characters.trim())
    budget.text--
  }
  for (const child of node.children ?? []) collectText(child, budget, out)
}

/** The blocks a set of frames renders to, plus the caps that cut them. */
export interface FigmaBlocksResult {
  blocks: DesignBlock[]
  /** Coverage notes for the caps that actually bit; empty when nothing was dropped. */
  notes: string[]
}

/**
 * Map the fetched Figma frames into the source-neutral {@link DesignBlock}s: one block
 * per frame, with a `Layout` bullet tree and the frame's `Text content`. The
 * design-system components are collected separately ({@link figmaComponents}) into the
 * shared global `### Components` section rather than per-frame.
 */
export function figmaBlocks(roots: FigmaNode[]): FigmaBlocksResult {
  // One budget for the whole import: a whole-file import renders many frames, so a
  // per-frame cap alone bounds nothing about the size of the context file it produces.
  const budget: ImportBudget = { nodes: MAX_IMPORT_NODES, text: MAX_IMPORT_TEXT }
  let cutFrames = 0

  const blocks = roots.map((root) => {
    const layout: string[] = []
    // One frame counter shared across every top-level child, so the per-frame cap bounds the
    // whole frame rather than each subtree: a wide frame can't pass it one branch at a time.
    const frame = { nodes: MAX_FRAME_NODES }
    let complete = true
    for (const child of root.children ?? []) {
      if (!renderLayout(child, 0, frame, budget, layout)) {
        layout.push('- … (truncated)')
        complete = false
        break
      }
    }
    if (!complete) cutFrames++

    const text: string[] = []
    collectText(root, budget, text)

    return {
      title: root.name?.trim() || '(unnamed frame)',
      meta: dimensionLabel(root),
      sections: [
        { heading: 'Layout', lines: layout },
        { heading: 'Text content', lines: text.map((t) => `- ${t.replace(/\s+/g, ' ')}`) },
      ],
    }
  })

  const notes: string[] = []
  if (cutFrames) {
    notes.push(
      `Layout is capped at ${MAX_TREE_DEPTH} levels and ${MAX_FRAME_NODES} nodes per frame ` +
        `(${MAX_IMPORT_NODES} across the import); ${cutFrames} of ${roots.length} frames were cut ` +
        `at a "(truncated)" marker. Open the frame in the design tool for what the tree stops at.`,
    )
  }
  return { blocks, notes }
}

/**
 * The top-level frames of a whole file, in document order: the page children a
 * {@link figmaBlocks} block is rendered from. The whole-file file read is shallow (it
 * returns these with no grandchildren), so the caller fetches their subtrees separately.
 */
export function figmaTopLevelFrames(document: FigmaNode | undefined): FigmaNode[] {
  const frames: FigmaNode[] = []
  for (const page of document?.children ?? []) {
    for (const child of page.children ?? []) {
      if (child.id && (!child.type || FRAME_TYPES.has(child.type))) frames.push(child)
    }
  }
  return frames
}

// ---- Components ------------------------------------------------------------

/** Strip Figma's `#1:0` disambiguation suffix off a component-property name. */
function cleanPropertyName(raw: string): string {
  return raw.split('#')[0]!.trim()
}

function renderPropertyValue(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return null
}

/** What one component instance says about itself: its variant, and the props it was given. */
interface ComponentUsage {
  variants: Set<string>
  props: Set<string>
  description?: string
}

function readInstanceProperties(
  props: FigmaComponentProperties | undefined,
  usage: ComponentUsage,
): void {
  for (const [rawName, entry] of Object.entries(props ?? {})) {
    const name = cleanPropertyName(rawName)
    if (!name) continue
    const value = renderPropertyValue(entry?.value)
    if (entry?.type === 'VARIANT') {
      if (value) usage.variants.add(`${name}=${value}`)
    } else {
      usage.props.add(value != null && entry?.type === 'BOOLEAN' ? `${name}=${value}` : name)
    }
  }
}

function collectComponents(
  node: FigmaNode,
  components: FigmaComponentMap,
  sets: FigmaComponentSetMap,
  out: Map<string, ComponentUsage>,
): void {
  if (node.type === 'INSTANCE') {
    const definition = node.componentId ? components[node.componentId] : undefined
    const set = definition?.componentSetId ? sets[definition.componentSetId] : undefined
    // A variant's own component name IS its property assignment ("Size=Large, Type=Primary"),
    // so it identifies the component only through its SET. Without a set, the component name
    // is the identity and there is no variant to report.
    const name = (set?.name || definition?.name || node.name)?.trim()
    if (name) {
      const usage = out.get(name) ?? { variants: new Set<string>(), props: new Set<string>() }
      if (set?.name && definition?.name?.includes('=')) usage.variants.add(definition.name.trim())
      readInstanceProperties(node.componentProperties, usage)
      usage.description ??= (definition?.description || set?.description)?.trim().split('\n')[0]
      out.set(name, usage)
    }
  }
  for (const child of node.children ?? []) collectComponents(child, components, sets, out)
}

function usageNote(usage: ComponentUsage): string | undefined {
  const parts: string[] = []
  const variants = [...usage.variants].sort()
  if (variants.length) {
    const shown = variants.slice(0, MAX_VARIANTS_PER_COMPONENT).join(' | ')
    const dropped = variants.length - Math.min(variants.length, MAX_VARIANTS_PER_COMPONENT)
    parts.push(`variants: ${shown}${dropped ? ` (+${dropped} more)` : ''}`)
  }
  const props = [...usage.props].sort()
  if (props.length) parts.push(`props: ${props.join(', ')}`)
  if (usage.description) parts.push(usage.description)
  return parts.length ? parts.join('; ') : undefined
}

/**
 * Collect the distinct design-system components instantiated across the frames, each with
 * the variants and properties the design actually uses. That signal is what lets an agent
 * match "reuse the existing component" against a repo component rather than a bare name.
 */
export function figmaComponents(
  roots: FigmaNode[],
  components: FigmaComponentMap = {},
  componentSets: FigmaComponentSetMap = {},
): DesignComponent[] {
  const usages = new Map<string, ComponentUsage>()
  for (const root of roots) collectComponents(root, components, componentSets, usages)
  return [...usages].map(([name, usage]) => ({ name, note: usageNote(usage) }))
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

// ---- Published styles → DesignToken[] --------------------------------------

/** How a published style's role maps to the token collection it belongs in. */
const STYLE_COLLECTIONS: Record<string, string> = {
  fill: 'Colors',
  fills: 'Colors',
  stroke: 'Strokes',
  strokes: 'Strokes',
  text: 'Typography',
}

/** The value a styled node carries for the given role, or null when we can't name one. */
function styledValue(node: FigmaNode, role: string): string | null {
  if (role === 'fill' || role === 'fills') return firstSolidHex(node.fills)
  if (role === 'stroke' || role === 'strokes') return firstSolidHex(node.strokes)
  if (role === 'text') return typographyLabel(node.style)
  return null
}

function collectStyleTokens(
  node: FigmaNode,
  styles: FigmaStyleMap,
  out: Map<string, DesignToken>,
): void {
  for (const [role, styleId] of Object.entries(node.styles ?? {})) {
    const collection = STYLE_COLLECTIONS[role]
    const name = styleId ? styles[styleId]?.name?.trim() : undefined
    if (!collection || !name) continue
    const value = styledValue(node, role)
    // A style with no resolvable value is a name and nothing else, which teaches an
    // implementer nothing they can apply. Skip it rather than emit `name = ?`.
    if (!value) continue
    const key = `${collection}:${name}`
    if (!out.has(key)) out.set(key, { collection, name, value })
  }
  for (const child of node.children ?? []) collectStyleTokens(child, styles, out)
}

/**
 * Derive tokens from the file's PUBLISHED STYLES, the token source every Figma plan
 * serves: the `styles` map names each published style and the nodes referencing one carry
 * the concrete value, so the join produces `name = value` without the Enterprise-gated
 * variables API. Deliberately NOT merged with {@link figmaTokens}: the two are different
 * sources with different coverage, and a merged section could not say which one it came
 * from.
 */
export function figmaStyleTokens(roots: FigmaNode[], styles: FigmaStyleMap = {}): DesignToken[] {
  const tokens = new Map<string, DesignToken>()
  for (const root of roots) collectStyleTokens(root, styles, tokens)
  return [...tokens.values()]
}

/** Whether the Enterprise-gated variables read succeeded, was plan-gated, or failed. */
export type FigmaVariablesStatus = 'ok' | 'gated' | 'failed'

/**
 * State which token path produced the section. A 403 from the variables API is a PLAN
 * GATE, not an error, and neither of those reads the same as a design that simply defines
 * no tokens, so the three cases must not collapse into one silent omission.
 */
export function figmaTokenOrigin(input: {
  status: FigmaVariablesStatus
  variableTokens: number
  styleTokens: number
}): DesignTokenOrigin | undefined {
  if (input.variableTokens > 0) return { label: 'Figma variables' }
  const missing =
    input.status === 'gated'
      ? 'the Figma variables API is not available on this plan'
      : input.status === 'failed'
        ? 'the Figma variables read failed'
        : null
  if (input.styleTokens > 0) {
    return {
      label: 'published styles',
      note: missing ? `Variable-defined tokens are absent: ${missing}.` : undefined,
    }
  }
  if (!missing) return undefined
  return {
    note: `No design tokens: ${missing}, and this design's published styles resolved to no value.`,
  }
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
  /** The `componentSetId → { name }` map: a variant's real identity. */
  componentSets?: FigmaComponentSetMap
  /** The file's published styles, the plan-independent token source. */
  styles?: FigmaStyleMap
  /** Local-variables payload, or null when the plan doesn't expose it. */
  variablesMeta?: FigmaVariablesMeta | null
  /** Whether the variables read succeeded, was plan-gated, or failed. */
  variablesStatus?: FigmaVariablesStatus
  /** Best-effort short-lived rendered-preview URL, or null. */
  previewUrl?: string | null
  /** Coverage caveats the fetch itself produced (dropped frames, a failed subtree read). */
  fetchNotes?: string[]
}

/** Assemble the fetched Figma pieces into the shared {@link DesignContext}. */
export function buildFigmaDesignContext(input: FigmaContextInput): DesignContext {
  const { fileKey } = splitFigmaExternalId(input.externalId)
  const title = input.nodeId
    ? `${input.fileName || fileKey} — ${input.roots[0]?.name?.trim() || input.nodeId}`
    : input.fileName || fileKey
  const { blocks, notes } = figmaBlocks(input.roots)
  const variableTokens = figmaTokens(input.variablesMeta)
  const styleTokens = figmaStyleTokens(input.roots, input.styles)
  return {
    title,
    url: figmaUrlFor(input.externalId),
    blocks,
    components: figmaComponents(input.roots, input.components, input.componentSets),
    tokens: variableTokens.length ? variableTokens : styleTokens,
    tokenOrigin: figmaTokenOrigin({
      status: input.variablesStatus ?? 'ok',
      variableTokens: variableTokens.length,
      styleTokens: styleTokens.length,
    }),
    references: input.previewUrl ? [{ label: 'Rendered preview', url: input.previewUrl }] : [],
    notes: [...(input.fetchNotes ?? []), ...notes],
  }
}
