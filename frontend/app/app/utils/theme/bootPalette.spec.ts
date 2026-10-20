import { describe, expect, it } from 'vitest'
import {
  BOOT_PALETTE_KEY,
  readBootPalette,
  writeBootPalette,
  type BootPaletteEntry,
} from '~/utils/theme/bootPalette'

const dark: BootPaletteEntry = {
  bg: 'oklch(0.129 0.042 264.695)',
  track: 'oklch(0.279 0.041 260.031)',
  accent: 'oklch(0.673 0.182 276.935)',
  status: 'oklch(0.704 0.04 256.788)',
}
const light: BootPaletteEntry = {
  bg: 'rgb(226, 232, 240)',
  track: '#cbd5e1',
  accent: 'black',
  status: 'rgb(100, 116, 139)',
}

describe('boot palette cache', () => {
  it('keeps one entry per colour mode under one theme', () => {
    writeBootPalette('cat-factory', 'dark', dark)
    writeBootPalette('cat-factory', 'light', light)
    expect(readBootPalette()).toEqual({ theme: 'cat-factory', dark, light })
    const darkAgain = { ...dark, accent: 'white' }
    writeBootPalette('cat-factory', 'dark', darkAgain)
    expect(readBootPalette()).toEqual({ theme: 'cat-factory', dark: darkAgain, light })
  })

  it("drops the other mode's entry when the theme changes, so a stale palette never dresses the shell", () => {
    writeBootPalette('cat-factory', 'dark', dark)
    writeBootPalette('cat-factory', 'light', light)
    const monoDark = { ...dark, accent: 'white' }
    writeBootPalette('mono', 'dark', monoDark)
    expect(readBootPalette()).toEqual({ theme: 'mono', dark: monoDark })
  })

  it('drops an entry that is not a set of computed colours', () => {
    localStorage.setItem(
      BOOT_PALETTE_KEY,
      JSON.stringify({
        theme: 'x',
        dark,
        light: { ...light, bg: 'red; } body { display: none' },
        other: dark,
      }),
    )
    expect(readBootPalette()).toEqual({ theme: 'x', dark })
    localStorage.setItem(BOOT_PALETTE_KEY, 'not json')
    expect(readBootPalette()).toEqual({})
  })
})
