import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SAFE_AREA_GUTTER_CLASS, SAFE_AREA_INSET_CLASS } from '~/utils/safeArea'

// A missing or misspelled side is silent on every screen without a notch, so the exact spellings
// are pinned here.
describe('safe-area classes', () => {
  it('gives a windowed overlay 1rem or the inset, whichever is larger, on every side', () => {
    expect(SAFE_AREA_GUTTER_CLASS.split(' ')).toEqual([
      'pt-[max(1rem,env(safe-area-inset-top))]',
      'pr-[max(1rem,env(safe-area-inset-right))]',
      'pb-[max(1rem,env(safe-area-inset-bottom))]',
      'pl-[max(1rem,env(safe-area-inset-left))]',
    ])
  })

  it('gives a full-bleed overlay only the inset, so it stays edge to edge without one', () => {
    expect(SAFE_AREA_INSET_CLASS.split(' ')).toEqual([
      'pt-[env(safe-area-inset-top)]',
      'pr-[env(safe-area-inset-right)]',
      'pb-[env(safe-area-inset-bottom)]',
      'pl-[env(safe-area-inset-left)]',
    ])
  })
})

// The padding is also silent when a full-screen overlay simply does not apply it: the header and
// close button sit under the notch on a phone, and on every other screen nothing changes. Four
// takeovers shipped that way. So every `fixed inset-0` surface in the app is classified here, and
// a new one fails until its author picks a row.

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Full-bleed takeovers: they pad by the inset and cap to the dynamic viewport. */
const FULL_BLEED = [
  'components/kaizen/KaizenPanel.vue',
  'components/media/ArtifactLightbox.vue',
  'components/panels/AgentStepDetail.vue',
  'components/panels/ObservabilityPanel.vue',
  'components/panels/OperatorDashboardPanel.vue',
  'components/panels/ReportsPanel.vue',
  'components/settings/ModelConfigurationPanel.vue',
]

/** Windowed overlays: the backdrop gutter keeps the window clear of the notch. */
const WINDOWED = ['components/panels/ResultWindowShell.vue']

/** `fixed inset-0` surfaces with no edge content to protect, and why. */
const EXEMPT: Record<string, string> = {
  'components/board/DependencyConnectOverlay.vue':
    'a pointer-events-none SVG that draws connector lines; it has no controls',
  'components/common/AsyncViewError.vue':
    'a card centred on a scrim, so its content is never at an edge',
  'components/layout/SideBar.vue':
    'the inset-0 element is the drawer scrim; the drawer pads its own bottom inset',
}

function vueFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return vueFiles(path)
    return entry.name.endsWith('.vue') ? [path] : []
  })
}

const fullScreen = vueFiles(appDir)
  .filter((path) => readFileSync(path, 'utf8').includes('fixed inset-0'))
  .map((path) => relative(appDir, path))
  .sort()

describe('full-screen overlays', () => {
  it('classifies every fixed inset-0 surface exactly once', () => {
    const classified = [...FULL_BLEED, ...WINDOWED, ...Object.keys(EXEMPT)]
    expect(new Set(classified).size).toBe(classified.length)
    expect([...classified].sort()).toEqual(fullScreen)
  })

  it.each(FULL_BLEED)('%s pads by the inset and caps to the dynamic viewport', (file) => {
    const source = readFileSync(join(appDir, file), 'utf8')
    expect(source).toContain(':class="SAFE_AREA_INSET_CLASS"')
    const root = source.split('\n').find((line) => line.includes('fixed inset-0'))
    expect(root).toContain('max-h-[100dvh]')
  })

  it.each(WINDOWED)('%s keeps its gutter clear of the inset', (file) => {
    expect(readFileSync(join(appDir, file), 'utf8')).toContain('SAFE_AREA_GUTTER_CLASS')
  })
})
