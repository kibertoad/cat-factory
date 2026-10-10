/**
 * The handful of colours the pre-JS loading shell (`spa-loading-template.html`) paints with,
 * cached per colour mode so the FIRST frame after a reload wears the active theme instead of the
 * default one.
 *
 * The shell renders before any stylesheet or the theme plugin exists, so it cannot resolve a token.
 * What it can do is read `localStorage` from a two-line inline script. So after every theme or
 * mode change the plugin resolves these tokens on `<html>` and writes the computed colours here,
 * keyed by mode UNDER the active theme's id: the colour-mode script in `<head>` has already classed
 * `<html>` when the shell paints, so the shell picks the entry for the mode it is about to show.
 * A theme change drops the other mode's entry too (it belonged to the previous theme), so a mode
 * never seen since the theme was picked has no entry and the shell falls back to its defaults.
 *
 * Values are computed colours (`oklch(...)`, `rgb(...)`), never the theme's own input, and the shell
 * applies them through `style.setProperty`, which cannot break out of a declaration.
 */

export const BOOT_PALETTE_KEY = 'cf-boot-palette'

export type ColorModeName = 'light' | 'dark'

/** The shell's slots, each the token it mirrors in the running app. */
export const BOOT_PALETTE_TOKENS = {
  bg: '--app-bg-canvas',
  track: '--ui-border',
  accent: '--ui-primary',
  status: '--ui-text-muted',
} as const

export type BootPaletteEntry = Record<keyof typeof BOOT_PALETTE_TOKENS, string>
export type BootPalette = { theme?: string } & Partial<Record<ColorModeName, BootPaletteEntry>>

// A computed colour as the browser reports it: a colour function or a hex literal.
const COMPUTED_COLOR = /^(?:[a-z]+\([\d.%,\s/a-z-]+\)|#[0-9a-f]{3,8}|[a-z]+)$/i

// A sentinel the probe's fallback lands on when a token is undefined. `color` is an INHERITED
// property, so a bare `color: var(--missing)` is invalid at computed-value time and resolves to the
// inherited colour (always a real `rgb(...)`), not to nothing: the guard below could never tell an
// unresolved token from a resolved one. Giving the `var()` this fallback makes the difference
// observable, since no theme paints a slot in it. `getComputedStyle` normalises it to this string.
const UNRESOLVED_SENTINEL = 'rgb(1, 2, 3)' // colour-literal-ok: a probe sentinel, never a painted colour

function isEntry(value: unknown): value is BootPaletteEntry {
  if (typeof value !== 'object' || value === null) return false
  return Object.keys(BOOT_PALETTE_TOKENS).every((slot) => {
    const colour = (value as Record<string, unknown>)[slot]
    return typeof colour === 'string' && COMPUTED_COLOR.test(colour)
  })
}

/** Resolve the shell's slots against the current document, or null if any is not resolvable yet. */
export function captureBootPalette(
  root: Element = document.documentElement,
): BootPaletteEntry | null {
  const probe = document.createElement('div')
  root.appendChild(probe)
  try {
    const entry: Partial<BootPaletteEntry> = {}
    for (const [slot, token] of Object.entries(BOOT_PALETTE_TOKENS)) {
      probe.style.color = `var(${token}, ${UNRESOLVED_SENTINEL})`
      const computed = getComputedStyle(probe).color
      if (computed === UNRESOLVED_SENTINEL || !COMPUTED_COLOR.test(computed)) return null
      entry[slot as keyof BootPaletteEntry] = computed
    }
    return entry as BootPaletteEntry
  } finally {
    probe.remove()
  }
}

export function readBootPalette(storage: Storage = localStorage): BootPalette {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(BOOT_PALETTE_KEY) ?? '{}')
    if (typeof parsed !== 'object' || parsed === null) return {}
    const palette: BootPalette = {}
    const theme = (parsed as Record<string, unknown>).theme
    if (typeof theme === 'string') palette.theme = theme
    for (const mode of ['light', 'dark'] as const) {
      const entry = (parsed as Record<string, unknown>)[mode]
      if (isEntry(entry)) palette[mode] = entry
    }
    return palette
  } catch {
    return {}
  }
}

/**
 * Record one mode's colours for a theme. The other mode's entry survives only if it was captured
 * under the SAME theme; otherwise it is the previous theme's and would dress the shell wrongly the
 * first time the OS starts the app in that mode.
 */
export function writeBootPalette(
  theme: string,
  mode: ColorModeName,
  entry: BootPaletteEntry,
  storage: Storage = localStorage,
): void {
  const previous = readBootPalette(storage)
  const palette: BootPalette = previous.theme === theme ? previous : { theme }
  palette.theme = theme
  palette[mode] = entry
  try {
    storage.setItem(BOOT_PALETTE_KEY, JSON.stringify(palette))
  } catch {
    // Storage full or disabled: the shell keeps its default colours, nothing else depends on it.
  }
}
