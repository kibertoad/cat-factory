import type {
  DocumentRenderPlan,
  DocumentSourceDescriptor,
  DocumentSourceOAuthSpec,
} from '@cat-factory/kernel'
import {
  capped,
  dimensionMeta,
  sortDesignTokens,
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

/** Figma's REST API host. The credential is sent to this host only — see {@link assertSafeFigmaUrl}. */
export const FIGMA_API_HOST = 'api.figma.com'

/**
 * The hosts Figma serves a RENDERED image from, as short-lived signed URLs the `/v1/images`
 * endpoint hands back. Two of them because the vendor has moved between these buckets and both
 * are still returned in the wild.
 *
 * Pinned to this fixed set for the same reason the API host is pinned: the URL comes back inside a
 * response body, so following it unchecked would let a compromised or spoofed API response point
 * the downloader at an internal address. Fail-CLOSED is the right trade here — a Figma that starts
 * serving from a third bucket costs the deployment its renders, which the import states, where the
 * alternative costs it an SSRF. The download itself carries NO credential (the URL is already
 * signed), so a host outside the set leaks nothing even before the guard refuses it.
 */
export const FIGMA_RENDER_HOSTS = [
  's3-alpha-sig.figma.com',
  'figma-alpha-api.s3.us-west-2.amazonaws.com',
] as const

/**
 * The scopes the OAuth consent screen asks for, and the reason each is on the list.
 *
 * `file_content:read` is what every import needs (the node tree, the published styles, the
 * component sets). `file_variables:read` is the Enterprise-gated variables read, requested
 * because asking for it costs nothing on a plan that does not grant it: the provider already
 * treats a 403 there as a PLAN GATE rather than an error and falls back to published styles, so
 * an over-broad ask degrades exactly as the PAT path does rather than failing the connect.
 */
const FIGMA_OAUTH_SCOPES = ['file_content:read', 'file_variables:read'] as const

/**
 * Figma's `authorization_code` endpoints.
 *
 * The authorize host is `www.figma.com` (the consent screen a person sees) while both token
 * endpoints are on the API host this provider is already pinned to, so a refresh crosses no host
 * the credential does not already reach.
 *
 * A refresh goes to `/v1/oauth/token`, the SAME endpoint as the code exchange: "Previously, you
 * used the `https://api.figma.com/v1/oauth/refresh` endpoint... Now, when you refresh your OAuth
 * tokens, you should use the `https://api.figma.com/v1/oauth/token` endpoint" (changelog
 * 2025-05-16, read 2026-08-18). The legacy path is "supported for now" with no retirement date,
 * which is exactly the kind of pin that breaks on a vendor's clock rather than on a deploy.
 */
export const FIGMA_OAUTH: DocumentSourceOAuthSpec = {
  authorizeUrl: 'https://www.figma.com/oauth',
  tokenUrl: `https://${FIGMA_API_HOST}/v1/oauth/token`,
  refreshUrl: `https://${FIGMA_API_HOST}/v1/oauth/token`,
  scopes: FIGMA_OAUTH_SCOPES,
  // Figma joins scopes with commas, not the RFC's space.
  scopeSeparator: ',',
}

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
      help: 'Create a personal access token at figma.com → Settings → Security → Personal access tokens (file_content + file_variables read scopes). Figma caps a new token at 90 days, so this credential expires on a clock and design imports stop until it is replaced; connecting through OAuth instead renews itself, and an organisation can use a plan access token that outlives any one person. Design tokens require an Enterprise plan; without it the tokens section is simply omitted.',
    },
  ],
  refLabel: 'Figma file or frame URL',
  refPlaceholder: 'https://www.figma.com/design/<key>/Title?node-id=1-2',
  // No catalogue search API for either credential — import a specific file/frame by URL.
  searchable: false,
  // The wire half of {@link FIGMA_OAUTH}: it says the SOURCE can be connected this way, and the
  // source listing says separately whether this deployment has a Figma app registered to do it.
  oauth: { scopes: [...FIGMA_OAUTH_SCOPES] },
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

/**
 * The node qualifier the input named that {@link parseFigmaRef} could NOT keep, or null.
 *
 * `parseRef` falls back to the whole FILE when a node id is not a simple `n` / `n:n` (a complex
 * instance id like `I2649:14930;2649:14746` is the common case, and Figma's Copy link emits one for
 * any component instance). That fallback is deliberate — nothing knows which frame such an id meant,
 * and guessing would attach the wrong one — but it turns "this frame" into "the entire design file"
 * with nothing in the resolved id to show it happened. This is what says it happened, and it returns
 * the qualifier AS PASTED so the person who pasted it can recognise their own link.
 *
 * Null when the reference kept its node (`fileKey:nodeId`) and when the paste named no node at all,
 * which are both "you got what you asked for".
 */
export function figmaDroppedNodeId(input: string, externalId: string): string | null {
  if (splitFigmaExternalId(externalId).nodeId) return null
  const raw = rawFigmaNodeQualifier(input)
  return raw && !normalizeFigmaNodeId(raw) ? raw : null
}

/** The node qualifier as the input spells it: a URL's `?node-id=`, or a bare ref's `:` suffix. */
function rawFigmaNodeQualifier(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  if (!trimmed.includes('/') && !/figma\.com/i.test(trimmed)) {
    const [, ...rest] = trimmed.split(':')
    return rest.length ? rest.join(':') : null
  }
  try {
    return new URL(trimmed).searchParams.get('node-id')
  } catch {
    return null
  }
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

// Every cap below is sized against the ~256 KB linked-context corpus budget
// (`context_documents_over_budget`), which is what decides whether this document reaches the
// agent at all. Worst case, roughly: layout 1,500 lines × ~60 B ≈ 90 KB, text 600 × ~50 B
// ≈ 30 KB, tokens 250 × ~50 B ≈ 13 KB, components 150 × ~80 B ≈ 12 KB, so a maximal import
// lands near 145 KB and leaves headroom for the rest of the corpus. RAISING ONE MEANS
// REDOING THAT ARITHMETIC, not just picking a bigger number.

/**
 * Levels of descendants rendered below a frame's own children. Exported because the provider
 * derives the API `depth=` it requests from it: the two must not drift, or the tree is cut by
 * the fetch at a depth the renderer never states.
 */
export const MAX_TREE_DEPTH = 6
/** Nodes rendered for one frame. */
const MAX_FRAME_NODES = 400
/** Nodes rendered across the WHOLE import: a whole-file import fans out over many frames. */
const MAX_IMPORT_NODES = 1500
/** Text lines collected for one frame, and across the whole import. */
const MAX_FRAME_TEXT = 200
const MAX_IMPORT_TEXT = 600
/** Top-level frames a whole-file import fetches as subtrees. */
export const MAX_FILE_FRAMES = 12
/**
 * Top-level frames a whole-file import RASTERISES, well below {@link MAX_FILE_FRAMES}.
 *
 * The two caps count the same frames and are deliberately different numbers, because they bound
 * different budgets: a frame's text costs the ~256 KB context corpus a few KB, while its PNG costs
 * the account's blob storage a megabyte or two and buys a reader nothing the next frame's picture
 * does not. Six covers the screens a design-led task is actually about; the text still covers
 * twelve, and the import says which frames it rendered.
 */
export const MAX_RENDERS = 6
/** Distinct variants listed on one component's note before the rest are summarised away. */
const MAX_VARIANTS_PER_COMPONENT = 6
/** Components listed, ranked by how often the design instantiates them. */
const MAX_COMPONENTS = 150
/** Token lines listed, whichever source produced them. */
const MAX_TOKENS = 250

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
function figmaColorHex(
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
 * Which cap cut a walk short. They are NOT interchangeable, and conflating them is what made
 * one deep branch cost a frame's every remaining sibling:
 *
 * - `depth` is LOCAL to a branch. The tree continues below what we render, and the branch
 *   beside it is unaffected, so the walk states the cut and CARRIES ON.
 * - `frame-nodes` / `import-nodes` are EXHAUSTION. Nothing further can render, in this frame
 *   or (for the import budget) in any frame after it, so the walk stops.
 *
 * They also want different reactions from the reader: a depth cut means link the sub-frame,
 * a frame cap means the frame is too big to import whole, and an import cap means the import
 * itself is over budget and should name fewer frames.
 */
type LayoutCut = 'depth' | 'frame-nodes' | 'import-nodes'

/** Every cap `figmaBlocks` counts frames against, layout and text alike. */
type FrameCut = LayoutCut | 'frame-text' | 'import-text'

/** The mutable state of one frame's layout walk: what it may still spend, and what cut it. */
interface LayoutWalk {
  /** Nodes this FRAME may still render. */
  frameNodes: number
  /** Nodes the whole IMPORT may still render, shared across frames. */
  budget: ImportBudget
  /** Every cap that actually bit, for the coverage notes. */
  cuts: Set<LayoutCut>
}

/**
 * Render a node and its descendants as an indented bullet tree (name, type, size, styling),
 * bounded in depth and in nodes so a huge frame can't blow up the context file.
 *
 * Returns false only on EXHAUSTION (see {@link LayoutCut}), which the caller must propagate:
 * a `true` return means siblings may still render, even when this branch was cut by depth.
 * The `(truncated)` marker is pushed by the exhaustion guard itself, at the depth the walk
 * actually ran out, so unwinding ancestors add nothing and one cut leaves ONE marker.
 */
function renderLayout(node: FigmaNode, depth: number, walk: LayoutWalk, lines: string[]): boolean {
  const indent = '  '.repeat(depth)
  if (walk.budget.nodes <= 0) {
    walk.cuts.add('import-nodes')
    lines.push(`${indent}- … (truncated)`)
    return false
  }
  if (walk.frameNodes <= 0) {
    walk.cuts.add('frame-nodes')
    lines.push(`${indent}- … (truncated)`)
    return false
  }
  walk.frameNodes--
  walk.budget.nodes--
  const name = node.name?.trim() || '(unnamed)'
  const type = node.type ? ` _${node.type}_` : ''
  const facts = figmaStylingFacts(node)
  const styling = facts.length ? ` [${facts.join('; ')}]` : ''
  lines.push(`${indent}- ${name}${type}${dimensionLabel(node)}${styling}`)

  const children = node.children ?? []
  if (!children.length) return true
  if (depth >= MAX_TREE_DEPTH) {
    // The design continues below what we render. Naming the count is what separates "the cap
    // stopped here" from "this node is a leaf", which an omitted line renders identically.
    walk.cuts.add('depth')
    const label = children.length === 1 ? 'node' : 'nodes'
    lines.push(`${indent}  - … (${children.length} deeper ${label} not shown)`)
    return true
  }
  for (const child of children) {
    if (!renderLayout(child, depth + 1, walk, lines)) return false
  }
  return true
}

/** The mutable state of one frame's text walk: what it may still spend, and what cut it. */
interface TextWalk {
  /** Text lines this FRAME may still collect. */
  frameLines: number
  /** Text lines the whole IMPORT may still collect, shared across frames. */
  budget: ImportBudget
  /** Which cap stopped the collection, if one did. */
  cut?: 'frame-text' | 'import-text'
}

/**
 * Collect every TEXT node's `characters`, in document order, bounded per frame and import.
 * Returns false when a cap stopped it, because an empty `Text content` section is DROPPED by
 * the renderer: without this the frames whose text the import budget refused read exactly
 * like frames that contain no text.
 */
function collectText(node: FigmaNode, walk: TextWalk, out: string[]): boolean {
  if (walk.budget.text <= 0) {
    walk.cut = 'import-text'
    return false
  }
  if (walk.frameLines <= 0) {
    walk.cut = 'frame-text'
    return false
  }
  if (node.type === 'TEXT' && node.characters?.trim()) {
    out.push(node.characters.trim())
    walk.frameLines--
    walk.budget.text--
  }
  for (const child of node.children ?? []) {
    if (!collectText(child, walk, out)) return false
  }
  return true
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
  // Frames counted per CAP, not one "was cut" tally: each cap is a different fact about the
  // import and asks a different thing of the reader.
  const cutFrames = new Map<FrameCut, number>()
  const count = (cut: FrameCut) => cutFrames.set(cut, (cutFrames.get(cut) ?? 0) + 1)

  const blocks = roots.map((root) => {
    // One frame counter shared across every top-level child, so the per-frame cap bounds the
    // whole frame rather than each subtree: a wide frame can't pass it one branch at a time.
    const walk: LayoutWalk = { frameNodes: MAX_FRAME_NODES, budget, cuts: new Set() }
    const layout: string[] = []
    for (const child of root.children ?? []) {
      if (!renderLayout(child, 0, walk, layout)) break
    }
    for (const cut of walk.cuts) count(cut)

    const textWalk: TextWalk = { frameLines: MAX_FRAME_TEXT, budget }
    const text: string[] = []
    collectText(root, textWalk, text)
    const lines = text.map((t) => `- ${t.replace(/\s+/g, ' ')}`)
    if (textWalk.cut) {
      count(textWalk.cut)
      // Keeps the section non-empty, so a refused budget can never render as "no text here".
      lines.push('- … (text truncated)')
    }

    return {
      title: root.name?.trim() || '(unnamed frame)',
      meta: dimensionLabel(root),
      sections: [
        { heading: 'Layout', lines: layout },
        { heading: 'Text content', lines },
      ],
    }
  })

  return { blocks, notes: capNotes(cutFrames, roots.length) }
}

/** One note per cap that bit, each naming what the reader must do about that particular cap. */
function capNotes(cutFrames: Map<FrameCut, number>, total: number): string[] {
  const notes: string[] = []
  const of = (n: number) => `${n} of ${total} frames`
  const depth = cutFrames.get('depth')
  if (depth) {
    notes.push(
      `Layout is rendered ${MAX_TREE_DEPTH} levels deep below each frame's own children; in ` +
        `${of(depth)} a branch continues past that and ends at a "(N deeper nodes not shown)" ` +
        `marker. Link that sub-frame's own URL to import it at full depth.`,
    )
  }
  const frameNodes = cutFrames.get('frame-nodes')
  if (frameNodes) {
    notes.push(
      `Layout is capped at ${MAX_FRAME_NODES} nodes per frame; ${of(frameNodes)} hit that cap ` +
        `and stop at a "(truncated)" marker, so their later siblings are absent entirely.`,
    )
  }
  const importNodes = cutFrames.get('import-nodes')
  if (importNodes) {
    notes.push(
      `The import-wide budget of ${MAX_IMPORT_NODES} layout nodes was spent; ${of(importNodes)} ` +
        `are missing part or all of their layout. Link individual frame URLs to import fewer ` +
        `frames at full fidelity.`,
    )
  }
  const frameText = cutFrames.get('frame-text')
  if (frameText) {
    notes.push(
      `Text content is capped at ${MAX_FRAME_TEXT} lines per frame; ${of(frameText)} stop at a ` +
        `"(text truncated)" marker.`,
    )
  }
  const importText = cutFrames.get('import-text')
  if (importText) {
    notes.push(
      `The import-wide budget of ${MAX_IMPORT_TEXT} text lines was spent; ${of(importText)} are ` +
        `missing part or all of their text. Link individual frame URLs to import fewer frames ` +
        `at full fidelity.`,
    )
  }
  return notes
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

/**
 * The frames a render pass covers, capped at {@link MAX_RENDERS} in document order, with the
 * frames the cap left out COUNTED rather than dropped.
 *
 * The count is what keeps a bounded pass from reading as a complete one: six pictures of a
 * twenty-frame file and six pictures of a six-frame file are the same list, and only one of them
 * means "this is the whole design".
 *
 * A `view` must identify ONE screen, because it is the key a captured screenshot pairs with, so
 * two frames may never resolve to the same one. Two ways they otherwise would:
 *
 * - A frame with no name. It still renders (its picture is worth having) under its id, which is
 *   the only honest label left; `(unnamed)` would collide every nameless frame onto one view.
 * - A name repeated across pages, which real files do constantly ("Header", "Empty state"). EVERY
 *   occurrence is then qualified by its id, including the first: letting the first keep the bare
 *   name would hand it to whichever frame the file happens to list first, so re-ordering a page
 *   would silently move a stored view from one screen to another.
 */
export function figmaRenderTargets(frames: readonly FigmaNode[]): DocumentRenderPlan {
  const selected: { id: string; name: string }[] = []
  let dropped = 0
  for (const frame of frames) {
    if (!frame.id) continue
    if (selected.length >= MAX_RENDERS) {
      dropped += 1
      continue
    }
    selected.push({ id: frame.id, name: frame.name?.trim() || frame.id })
  }
  // Counted over the SELECTED frames, not the whole file: a duplicate the cap already excluded
  // would otherwise qualify a name that is unique among the frames actually rendered.
  const occurrences = new Map<string, number>()
  for (const frame of selected) {
    occurrences.set(frame.name, (occurrences.get(frame.name) ?? 0) + 1)
  }
  return {
    targets: selected.map((frame) => ({
      id: frame.id,
      view: (occurrences.get(frame.name) ?? 0) > 1 ? `${frame.name} (${frame.id})` : frame.name,
    })),
    capped: dropped,
  }
}

/**
 * How many importable frames each page contributes, in the same document order
 * {@link figmaTopLevelFrames} flattens. The frame cap counts frames, so on its own it cannot
 * say whether it stopped mid-page or dropped a whole page of the design: this is what lets the
 * cap note name the pages, which is the difference between "some frames are missing" and "you
 * imported none of page 2".
 */
export function figmaPageSummary(
  document: FigmaNode | undefined,
): { name: string; frames: number }[] {
  const pages: { name: string; frames: number }[] = []
  for (const [index, page] of (document?.children ?? []).entries()) {
    const frames = (page.children ?? []).filter(
      (child) => child.id && (!child.type || FRAME_TYPES.has(child.type)),
    ).length
    if (frames) pages.push({ name: page.name?.trim() || `Page ${index + 1}`, frames })
  }
  return pages
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
  /**
   * Instances seen. Not rendered: it exists so the component cap keeps the components the
   * design leans on rather than an arbitrary slice, a ranking COMPUTED from observed instances
   * rather than read off anyone's judgement.
   */
  instances: number
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
      const usage = out.get(name) ?? {
        variants: new Set<string>(),
        props: new Set<string>(),
        instances: 0,
      }
      usage.instances++
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
  const variants = capped([...usage.variants].sort(), MAX_VARIANTS_PER_COMPONENT)
  if (variants.items.length) {
    const shown = variants.items.join(' | ')
    parts.push(`variants: ${shown}${variants.dropped ? ` (+${variants.dropped} more)` : ''}`)
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
 *
 * Ordered by instance count (ties by name, so the result is deterministic) because that order
 * is what the component cap slices: the components the design leans on survive it. The
 * renderer sorts alphabetically for display, so the order here is a RANKING, not a layout.
 */
export function figmaComponents(
  roots: FigmaNode[],
  components: FigmaComponentMap = {},
  componentSets: FigmaComponentSetMap = {},
): DesignComponent[] {
  const usages = new Map<string, ComponentUsage>()
  for (const root of roots) collectComponents(root, components, componentSets, usages)
  return [...usages]
    .sort(([aName, a], [bName, b]) => b.instances - a.instances || aName.localeCompare(bName))
    .map(([name, usage]) => ({ name, note: usageNote(usage) }))
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

  // Components and tokens are bounded too: both grow with the DESIGN SYSTEM rather than with
  // the frames imported, so the layout/text budgets above say nothing about them, and a
  // library file can carry hundreds of published styles.
  const components = capped(
    figmaComponents(input.roots, input.components, input.componentSets),
    MAX_COMPONENTS,
  )
  const tokens = capped(
    sortDesignTokens(variableTokens.length ? variableTokens : styleTokens),
    MAX_TOKENS,
  )
  const capNotes: string[] = []
  if (components.dropped) {
    capNotes.push(
      `${components.dropped} of ${components.dropped + components.items.length} components are ` +
        `not listed: the ${MAX_COMPONENTS} instantiated most often were kept (the list itself is ` +
        `alphabetical).`,
    )
  }
  if (tokens.dropped) {
    capNotes.push(
      `${tokens.dropped} of ${tokens.dropped + tokens.items.length} design tokens are not ` +
        `listed; the list is capped at ${MAX_TOKENS} and is otherwise in full.`,
    )
  }

  return {
    title,
    url: figmaUrlFor(input.externalId),
    blocks,
    components: components.items,
    tokens: tokens.items,
    tokenOrigin: figmaTokenOrigin({
      status: input.variablesStatus ?? 'ok',
      variableTokens: variableTokens.length,
      styleTokens: styleTokens.length,
    }),
    references: input.previewUrl ? [{ label: 'Rendered preview', url: input.previewUrl }] : [],
    notes: [...(input.fetchNotes ?? []), ...notes, ...capNotes],
  }
}
