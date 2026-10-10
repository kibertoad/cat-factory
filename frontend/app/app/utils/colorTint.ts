/**
 * A translucent fill of a colour, for the icon tiles and badges that sit a category colour behind
 * its own glyph. The colour is a CSS value, never parsed: identity colours are `var(--app-hue-*)`
 * tokens (`utils/catalog.ts`) and a deployment-registered kind may still send a hex, and
 * `color-mix` reads both. `percent` is the fill's opacity (the old `+ '22'` hex-alpha suffix was
 * 34/255, about 13%).
 */
export function tint(color: string, percent = 13): string {
  return `color-mix(in srgb, ${color} ${percent}%, transparent)`
}
