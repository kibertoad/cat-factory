import type { DocumentSourceDescriptor } from '@cat-factory/kernel'
import {
  dimensionMeta,
  type DesignBlock,
  type DesignComponent,
  type DesignContext,
  type DesignToken,
} from './design.logic.js'
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
  // The WHOLE segment is validated, not an alphanumeric prefix of it: a partial match would mint a
  // truncated id that looks resolved and 404s on import, where falling back to the project at least
  // reaches a real page (and `zeplinDroppedScreenId` states that it did).
  const project = pathSegmentAfter(url.pathname, 'project')
  if (!project || !ID.test(project)) return null
  const screen = pathSegmentAfter(url.pathname, 'screen')
  return screen && ID.test(screen) ? `${project}:${screen}` : project
}

/** The path segment following `key`, or null when the path does not name one. */
function pathSegmentAfter(pathname: string, key: string): string | null {
  const segments = pathname.split('/').filter(Boolean)
  const idx = segments.indexOf(key)
  return idx === -1 ? null : (segments[idx + 1] ?? null)
}

/**
 * The screen qualifier the input named that {@link parseZeplinRef} could NOT keep, or null.
 *
 * Zeplin's ref grammar is two-level like Figma's, and so is its fallback: a screen id the parser
 * cannot read leaves the reference pointing at the whole PROJECT, which resolves and imports
 * perfectly well while covering far more than the screen someone linked. Returns the qualifier as
 * pasted, for the same reason Figma's does. Null when the screen survived, or when none was named.
 */
export function zeplinDroppedScreenId(input: string, externalId: string): string | null {
  if (splitZeplinExternalId(externalId).screenId) return null
  const raw = rawZeplinScreenQualifier(input)
  // Detected on the RAW segment (what `parseRef` judged) and REPORTED decoded (what the person
  // pasted): a `%20` in the warning names nothing they would recognise, and deciding on the decoded
  // form would call a `%41` that the parse dropped "kept".
  return raw && !ID.test(raw) ? readableQualifier(raw) : null
}

/** A path segment as it was pasted; a malformed escape is quoted verbatim rather than lost. */
function readableQualifier(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/** The screen qualifier as the input spells it: a URL's `/screen/<id>`, or a bare ref's suffix. */
function rawZeplinScreenQualifier(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  if (!trimmed.includes('/') && !/zeplin\.io/i.test(trimmed)) {
    const [, ...rest] = trimmed.split(':')
    return rest.length ? rest.join(':') : null
  }
  try {
    return pathSegmentAfter(new URL(trimmed).pathname, 'screen')
  } catch {
    return null
  }
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

// ---- Response envelope unwrapping -----------------------------------------

// Zeplin's REST responses are inconsistent about wrapping collections/objects in a named
// envelope (`{ screens: [...] }` / `{ screen: {...} }`) vs returning them bare, so every
// read normalises through these. Pure + exported so the provider shell stays a thin fetch
// layer and the unwrap is unit-testable without a network.

/** Accept either a bare array or a `{ <key>: [...] }` envelope, else an empty array. */
export function unwrapArray<T>(value: unknown, key: string): T[] {
  if (Array.isArray(value)) return value as T[]
  if (value && typeof value === 'object') {
    const inner = (value as Record<string, unknown>)[key]
    if (Array.isArray(inner)) return inner as T[]
  }
  return []
}

/** Accept either a bare object or a `{ <key>: {...} }` envelope, else null. */
export function unwrapObject<T>(value: unknown, key: string): T | null {
  if (!value || typeof value !== 'object') return null
  const inner = (value as Record<string, unknown>)[key]
  if (inner && typeof inner === 'object') return inner as T
  return value as T
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

/**
 * The single source of truth for how many screens a whole-project import pulls and
 * renders: {@link ZeplinProvider} builds its `?limit=` query from this, and
 * {@link zeplinScreensToBlocks} bounds the rendered blocks by it, so the fetch and the
 * render can't drift.
 */
export const MAX_SCREENS = 40

/**
 * Screens REQUESTED from the API: one more than {@link MAX_SCREENS} is rendered, so that a
 * project with more screens than we import is DETECTABLE.
 *
 * Asking for exactly `MAX_SCREENS` makes the two indistinguishable (a full page and a truncated
 * one are both 40 rows), which silently drops the cap note for every project the cap actually
 * bites: the one case it exists for. The extra row is a PROBE and is never rendered, so what
 * the reader sees is still bounded by `MAX_SCREENS`.
 */
export const SCREEN_FETCH_LIMIT = MAX_SCREENS + 1

function screenMeta(screen: ZeplinScreen): string | undefined {
  return dimensionMeta(screen.image?.width, screen.image?.height)
}

/** Map Zeplin screens into source-neutral blocks (name + an optional description line). */
function zeplinScreensToBlocks(screens: ZeplinScreen[]): DesignBlock[] {
  return screens.slice(0, MAX_SCREENS).map((screen) => ({
    title: screen.name?.trim() || '(unnamed screen)',
    meta: screenMeta(screen),
    sections: screen.description?.trim()
      ? [{ heading: 'Description', lines: [screen.description.trim()] }]
      : [],
  }))
}

/** Map Zeplin components into source-neutral components (grouped by their section). */
function zeplinComponentsToDesign(components: ZeplinComponent[]): DesignComponent[] {
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
  /** Which of the supplementary reads failed, so their absence isn't read as emptiness. */
  failedReads?: { components?: boolean; designTokens?: boolean }
}

/** Assemble the fetched Zeplin pieces into the shared {@link DesignContext}. */
export function buildZeplinDesignContext(input: ZeplinContextInput): DesignContext {
  const { projectId, screenId } = splitZeplinExternalId(input.externalId)
  const title =
    screenId && input.screens[0]?.name?.trim()
      ? `${input.projectName || projectId} — ${input.screens[0]!.name!.trim()}`
      : input.projectName || projectId
  const notes: string[] = []
  if (input.failedReads?.components) {
    notes.push(
      'The Zeplin component read failed, so the components section is missing rather than empty.',
    )
  }
  // The fetch asks for SCREEN_FETCH_LIMIT, so more than MAX_SCREENS rows means the cap bit.
  // It does NOT reveal how many more there are, and stating a total we do not have would be a
  // guess dressed as a count, so the note says "more than" instead.
  if (input.screens.length > MAX_SCREENS) {
    notes.push(
      `This project has more than ${MAX_SCREENS} screens; the first ${MAX_SCREENS} were ` +
        `imported. Link a specific screen URL to import one that is not listed here.`,
    )
  }
  return {
    title,
    url: zeplinUrlFor(input.externalId),
    blocks: zeplinScreensToBlocks(input.screens),
    components: zeplinComponentsToDesign(input.components),
    tokens: zeplinTokens(input.designTokens),
    // Zeplin has ONE token source, so an origin is worth rendering only when its read
    // failed: without it a failed read and a project defining no tokens look identical.
    tokenOrigin: input.failedReads?.designTokens
      ? { note: 'No design tokens: the Zeplin design-tokens read failed.' }
      : undefined,
    references: [],
    notes,
  }
}
