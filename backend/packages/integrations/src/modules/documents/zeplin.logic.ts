import type { DocumentSourceDescriptor } from '@cat-factory/kernel'
import type { DesignBlock, DesignComponent, DesignContext, DesignToken } from './design.logic.js'
import { assertHostPinned } from './http.js'

// Zeplin-specific pure logic, kept out of the provider shell so it is unit-testable
// without a live workspace: parsing/canonicalising a project+screen ref out of user input,
// the fixed-host SSRF guard, and mapping Zeplin's screens / components / design-tokens JSON
// into the source-neutral `DesignContext` the shared `renderDesignContext` emits. The
// `fetch` itself (the `Authorization: Bearer` REST client) lives in `ZeplinProvider`.
//
// Zeplin is the design→dev *handoff* tool, so its content model is screens + a
// design-system (components + tokens), NOT Figma's node tree — which is exactly why it
// rides the shared `DesignContext` rather than a Figma-shaped renderer.

/** Zeplin's REST API host. The PAT is sent to this host only — see {@link assertSafeZeplinUrl}. */
export const ZEPLIN_API_HOST = 'api.zeplin.dev'

/** What the connect UI renders, and which credentials the provider needs. */
export const ZEPLIN_DESCRIPTOR: DocumentSourceDescriptor = {
  source: 'zeplin',
  label: 'Zeplin',
  icon: 'i-lucide-layout-template',
  credentialFields: [
    {
      key: 'apiToken',
      label: 'Personal access token',
      secret: true,
      placeholder: 'zeplin PAT',
      help: 'Create a personal access token in Zeplin → Profile → Developer → Personal access tokens. It is stored sealed and shared by the workspace.',
    },
  ],
  refLabel: 'Zeplin project or screen URL',
  refPlaceholder: 'https://app.zeplin.io/project/<projectId>/screen/<screenId>',
  // No catalogue search exposed here — import a specific project/screen by URL.
  searchable: false,
}

/**
 * The Zeplin REST host is fixed, so any request/redirect must stay on `api.zeplin.dev`
 * over https; a redirect off-host is treated as an SSRF attempt and rejected. Mirrors the
 * per-hop guard the other host-pinned providers run. Kept pure so it is unit-testable
 * without a network.
 */
export function assertSafeZeplinUrl(url: string): void {
  assertHostPinned(url, ZEPLIN_API_HOST, 'Zeplin')
}

// ---- Ref parsing + canonical URL ------------------------------------------

const ID = /^[A-Za-z0-9]+$/

/**
 * Resolve a Zeplin reference from raw user input into the stable composite external id
 * this provider stores: `"<projectId>"` for a whole-project link, or
 * `"<projectId>:<screenId>"` for a specific screen. Accepts an `app.zeplin.io`
 * project/screen URL, a bare project id, or a `projectId:screenId` string. Returns null
 * when no project id is found.
 */
export function parseZeplinRef(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  // Bare ref: a project id, optionally `:`-suffixed with a screen id.
  if (!trimmed.includes('/') && !/zeplin\.io/i.test(trimmed)) {
    const [project, screen, ...rest] = trimmed.split(':')
    if (!project || !ID.test(project) || rest.length) return null
    if (!screen) return project
    return ID.test(screen) ? `${project}:${screen}` : project
  }

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  if (!/(^|\.)zeplin\.io$/i.test(url.hostname)) return null
  const project = url.pathname.match(/\/project\/([A-Za-z0-9]+)/)?.[1]
  if (!project) return null
  const screen = url.pathname.match(/\/screen\/([A-Za-z0-9]+)/)?.[1]
  return screen ? `${project}:${screen}` : project
}

/** Split a composite external id back into its project id and optional screen id. */
export function splitZeplinExternalId(externalId: string): {
  projectId: string
  screenId?: string
} {
  const idx = externalId.indexOf(':')
  if (idx === -1) return { projectId: externalId }
  return { projectId: externalId.slice(0, idx), screenId: externalId.slice(idx + 1) }
}

/** Build the canonical web URL stored on the imported document. */
export function zeplinUrlFor(externalId: string): string {
  const { projectId, screenId } = splitZeplinExternalId(externalId)
  const base = `https://app.zeplin.io/project/${projectId}`
  return screenId ? `${base}/screen/${screenId}` : base
}

// ---- Zeplin JSON → DesignContext ------------------------------------------

export interface ZeplinScreen {
  id?: string
  name?: string
  description?: string
  image?: { width?: number; height?: number } | null
}

export interface ZeplinComponent {
  id?: string
  name?: string
  description?: string
  section?: { name?: string } | null
}

/** A Zeplin colour token: 0–255 channels + 0–1 alpha (Zeplin's representation). */
interface ZeplinColor {
  name?: string
  r?: number
  g?: number
  b?: number
  a?: number
}

interface ZeplinTextStyle {
  name?: string
  font_family?: string
  font_size?: number
}

interface ZeplinSpacing {
  name?: string
  value?: number
}

/** The `/projects/:id/design_tokens` payload we read (lenient — verify-at-build). */
export interface ZeplinDesignTokens {
  colors?: ZeplinColor[]
  text_styles?: ZeplinTextStyle[]
  spacing?: ZeplinSpacing[]
  measurements?: ZeplinSpacing[]
}

const MAX_SCREENS = 40

function screenMeta(screen: ZeplinScreen): string | undefined {
  const w = screen.image?.width
  const h = screen.image?.height
  return w != null && h != null ? ` (${Math.round(w)}×${Math.round(h)})` : undefined
}

/** Map Zeplin screens into source-neutral blocks (name + an optional description line). */
export function zeplinScreensToBlocks(screens: ZeplinScreen[]): DesignBlock[] {
  return screens.slice(0, MAX_SCREENS).map((screen) => ({
    title: screen.name?.trim() || '(unnamed screen)',
    meta: screenMeta(screen),
    sections: screen.description?.trim()
      ? [{ heading: 'Description', lines: [screen.description.trim()] }]
      : [],
  }))
}

/** Map Zeplin components into source-neutral components (grouped by their section). */
export function zeplinComponentsToDesign(components: ZeplinComponent[]): DesignComponent[] {
  return components
    .filter((c) => c.name?.trim())
    .map((c) => ({
      name: c.name!.trim(),
      group: c.section?.name?.trim() || undefined,
      note: c.description?.trim() || undefined,
    }))
}

function colorHex(c: ZeplinColor): string {
  const to2 = (n: number | undefined) =>
    Math.max(0, Math.min(255, Math.round(n ?? 0)))
      .toString(16)
      .padStart(2, '0')
  const hex = `#${to2(c.r)}${to2(c.g)}${to2(c.b)}`
  return c.a != null && c.a < 1 ? `${hex} (a=${c.a.toFixed(2)})` : hex
}

/** Map Zeplin design tokens (colours / typography / spacing) into source-neutral tokens. */
export function zeplinTokens(tokens: ZeplinDesignTokens | undefined | null): DesignToken[] {
  if (!tokens) return []
  const out: DesignToken[] = []
  for (const c of tokens.colors ?? []) {
    if (c.name?.trim()) out.push({ collection: 'Colors', name: c.name.trim(), value: colorHex(c) })
  }
  for (const t of tokens.text_styles ?? []) {
    if (!t.name?.trim()) continue
    const value = [t.font_family, t.font_size != null ? `${t.font_size}px` : null]
      .filter(Boolean)
      .join(' ')
    out.push({ collection: 'Typography', name: t.name.trim(), value: value || '—' })
  }
  for (const s of [...(tokens.spacing ?? []), ...(tokens.measurements ?? [])]) {
    if (s.name?.trim()) {
      out.push({ collection: 'Spacing', name: s.name.trim(), value: String(s.value ?? '') })
    }
  }
  return out
}

export interface ZeplinContextInput {
  /** The composite external id (`<projectId>` or `<projectId>:<screenId>`). */
  externalId: string
  /** The Zeplin project's name (from the API), used for the document title. */
  projectName: string
  /** The fetched screens (the whole project, or just the one referenced). */
  screens: ZeplinScreen[]
  /** The project's design-system components. */
  components: ZeplinComponent[]
  /** The project's design tokens, or null when unavailable. */
  designTokens?: ZeplinDesignTokens | null
}

/** Assemble the fetched Zeplin pieces into the shared {@link DesignContext}. */
export function buildZeplinDesignContext(input: ZeplinContextInput): DesignContext {
  const { projectId, screenId } = splitZeplinExternalId(input.externalId)
  const title =
    screenId && input.screens[0]?.name?.trim()
      ? `${input.projectName || projectId} — ${input.screens[0]!.name!.trim()}`
      : input.projectName || projectId
  return {
    title,
    url: zeplinUrlFor(input.externalId),
    blocks: zeplinScreensToBlocks(input.screens),
    components: zeplinComponentsToDesign(input.components),
    tokens: zeplinTokens(input.designTokens),
    references: [],
  }
}
