import { describe, expect, it } from 'vitest'
import type { ModelPreset } from '~/types/model-presets'
import { useModelPresetsStore } from '~/stores/modelPresets'
import { useModelPresetHealth } from '~/composables/useModelPresetHealth'

/**
 * The startup model-preset advisory. Its sibling `usePipelineHealth` has had a spec since the
 * catalog-drift bug; this one had none until `mdp_chatgpt` shipped and made the gap visible: the
 * advisory NAMES a built-in the board holds no row for, and a name is the only thing in that modal
 * a user can act on.
 */

let nextId = 0
function stored(over: Partial<ModelPreset> = {}): ModelPreset {
  return {
    id: `mdp_stored_${nextId++}`,
    name: 'Stored',
    baseModelId: 'kimi-k2.7',
    overrides: {},
    isDefault: false,
    version: 1,
    createdAt: nextId,
    ...over,
  }
}

/** Seed the store the way a snapshot hydrate does (rows + the catalog version/name pair), then scan. */
function scan(
  presets: ModelPreset[],
  versions: Record<string, number>,
  names: Record<string, string> = {},
) {
  useModelPresetsStore().hydrate(presets, versions, names)
  return useModelPresetHealth()
}

describe('useModelPresetHealth', () => {
  it('names a new built-in from the catalog map, not from its humanised id', () => {
    // The regression this file exists for. Every board created before the preset shipped hits this
    // branch on its next load, and the humanised id reads "chatgpt" (rendered "Chatgpt" by the
    // modal's `capitalize`) for a preset the rest of the product calls GPT-5.6 Sol.
    const { newPresets } = scan([], { mdp_chatgpt: 1 }, { mdp_chatgpt: 'GPT-5.6 Sol' })
    expect(newPresets.value).toEqual([{ type: 'new', id: 'mdp_chatgpt', name: 'GPT-5.6 Sol' }])
  })

  it('falls back to the humanised id when the facade ships no name map', () => {
    // Forward-compatibility only: the field is optional on the wire, so an older facade's snapshot
    // must still produce an offer rather than a blank row.
    const { newPresets } = scan([], { mdp_chatgpt: 1 })
    expect(newPresets.value).toEqual([{ type: 'new', id: 'mdp_chatgpt', name: 'chatgpt' }])
  })

  it('prefers the STORED row name over the catalog one for an outdated built-in', () => {
    // A stored built-in is what the user sees in their library, and its name is what they renamed
    // it to (or the older catalog name a reseed is about to replace). Reporting the catalog's newer
    // name here would describe the row by the value the fix installs, not the one on screen.
    const { outdated, newPresets } = scan(
      [stored({ id: 'mdp_claude', name: 'Claude Opus 4.8', version: 1 })],
      { mdp_claude: 2 },
      { mdp_claude: 'Claude Opus 5' },
    )
    expect(newPresets.value).toEqual([])
    expect(outdated.value).toEqual([
      { type: 'outdated', id: 'mdp_claude', name: 'Claude Opus 4.8', fromVersion: 1, toVersion: 2 },
    ])
  })

  it('reports nothing when every built-in is stored at its catalog version', () => {
    const { issues, hasIssues } = scan(
      [stored({ id: 'mdp_kimi', name: 'Kimi K2.7', version: 1 })],
      { mdp_kimi: 1 },
      { mdp_kimi: 'Kimi K2.7' },
    )
    expect(issues.value).toEqual([])
    expect(hasIssues.value).toBe(false)
  })

  it('ignores a user-created preset, which no catalog version covers', () => {
    const { issues } = scan([stored({ id: 'mdp_mine', version: 99 })], { mdp_kimi: 1 })
    expect(issues.value.map((i) => i.id)).toEqual(['mdp_kimi'])
  })
})
