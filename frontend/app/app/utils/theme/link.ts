import type { ThemeDoc, ThemeLink } from '~/utils/theme/doc'
import { presets } from '~/utils/theme/presets'

/**
 * Decoding a Nuxt UI theme editor link (`https://ui.nuxt.com/theme?doc=<payload>`). The payload
 * is the theme document as JSON, deflate-raw compressed, base64url encoded; an uncompressed
 * JSON payload is the editor's own fallback for a browser without `CompressionStream`, so both are
 * read here. Mirrors `docs/app/utils/theme/link.ts` in nuxt/ui.
 *
 * The result is a DISCRIMINATED outcome, not a nullable: the import dialog shows a different remedy
 * for "this is not a editor link" than for "this link is a preset shorthand", and a bare `null`
 * would make the two indistinguishable.
 */

export type ThemeLinkDecodeResult =
  | { ok: true; doc: ThemeDoc }
  | { ok: false; reason: 'not_a_link' | 'malformed' | 'preset_shorthand' | 'unsupported_version' }

/** The `doc` payload out of a editor URL, a bare payload, or raw document JSON. */
export function extractThemePayload(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  if (trimmed.startsWith('{')) return trimmed
  try {
    const url = new URL(trimmed)
    return url.searchParams.get('doc')
  } catch {
    // Not a URL: accept a copied payload on its own as long as it is base64url-shaped.
    return /^[\w-]+$/.test(trimmed) ? trimmed : null
  }
}

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array | undefined> {
  if (typeof DecompressionStream === 'undefined') return undefined
  try {
    const stream = new Blob([bytes as BlobPart])
      .stream()
      .pipeThrough(new DecompressionStream('deflate-raw'))
    return new Uint8Array(await new Response(stream).arrayBuffer())
  } catch {
    return undefined
  }
}

function parseDoc(bytes: Uint8Array | undefined): ThemeLink | undefined {
  if (!bytes) return undefined
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
    return parsed && typeof parsed === 'object' ? (parsed as ThemeLink) : undefined
  } catch {
    return undefined
  }
}

/**
 * The editor collapses a link whose document is exactly one of its presets to a bare
 * `{ version, preset }`; `presets.ts` carries their documents so such a link rebuilds here. A
 * preset id this copy does not know (the editor added one since) is reported, not guessed.
 */
function presetDoc(id: string): ThemeDoc | undefined {
  return presets.find((preset) => preset.id === id)?.doc
}

/** Decode a editor link, payload or raw JSON into a theme document. */
export async function decodeThemeLink(input: string): Promise<ThemeLinkDecodeResult> {
  const payload = extractThemePayload(input)
  if (!payload) return { ok: false, reason: 'not_a_link' }

  let link: ThemeLink | undefined
  if (payload.startsWith('{')) {
    link = parseDoc(new TextEncoder().encode(payload))
  } else {
    let bytes: Uint8Array
    try {
      bytes = Uint8Array.from(atob(payload.replace(/-/g, '+').replace(/_/g, '/')), (char) =>
        char.charCodeAt(0),
      )
    } catch {
      return { ok: false, reason: 'malformed' }
    }
    link = parseDoc(await inflateRaw(bytes)) ?? parseDoc(bytes)
  }
  if (!link) return { ok: false, reason: 'malformed' }
  if (link.version !== 1) return { ok: false, reason: 'unsupported_version' }

  const { preset, ...doc } = link
  if (preset) {
    const rebuilt = presetDoc(preset)
    if (!rebuilt) return { ok: false, reason: 'preset_shorthand' }
    return { ok: true, doc: { ...structuredClone(rebuilt), ...doc } }
  }
  return { ok: true, doc }
}
