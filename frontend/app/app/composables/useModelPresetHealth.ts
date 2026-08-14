import { computed } from 'vue'
import type { ModelPreset } from '~/types/model-presets'
import { useModelPresetsStore } from '~/stores/modelPresets'

export type ModelPresetIssueType = 'outdated' | 'new'

/** A built-in model preset that the workspace should reseed (an update, or a new one to add). */
export interface ModelPresetIssue {
  type: ModelPresetIssueType
  /** The catalog (built-in) id — what the reseed endpoint is keyed by. */
  id: string
  /** The preset name (the stored copy's for `outdated`, the built-in id for a `new` one). */
  name: string
  /** For an `outdated` issue: the persisted copy's version (the display copy renders it via i18n). */
  fromVersion?: number
  /** For an `outdated` issue: the newer catalog version available. */
  toVersion?: number
}

/**
 * A built-in's display name for an issue message: the stored row's when there is one, else the
 * catalog's own name from the snapshot's companion map.
 *
 * The humanised id (`mdp_kimi` to "kimi", rendered capitalised) is the FALLBACK for a facade that
 * ships no name map, not the primary answer. It reads acceptably for the built-ins whose ids ARE
 * their names and wrongly for the first one where it is not: `mdp_chatgpt` came out as "Chatgpt" in
 * the modal offering to add it, a name for GPT-5.6 Sol that appears nowhere else in the product,
 * on exactly the boards that predate the preset and therefore see this advisory.
 */
function builtinName(
  id: string,
  stored: ModelPreset | undefined,
  names: Record<string, string>,
): string {
  if (stored) return stored.name
  return names[id] ?? id.replace(/^mdp_/, '').replace(/_/g, ' ')
}

/**
 * Detect built-in model presets the workspace should reseed for the startup advisory: a stored
 * built-in whose catalog definition moved ahead (offer to adopt it) and a brand-new built-in
 * that appeared in the catalog but isn't in the workspace yet (offer to add it). The catalog
 * versions the snapshot ships ARE the set of built-in ids, so detection is entirely client-side:
 * a stored preset is a built-in iff its id is a catalog key, and a catalog key with no stored
 * preset is a new built-in.
 */
export function useModelPresetHealth() {
  const store = useModelPresetsStore()

  const issues = computed<ModelPresetIssue[]>(() => {
    const out: ModelPresetIssue[] = []
    const byId = new Map(store.presets.map((p) => [p.id, p]))
    for (const [id, catalogVersion] of Object.entries(store.catalogVersions)) {
      const stored = byId.get(id)
      if (!stored) {
        out.push({ type: 'new', id, name: builtinName(id, undefined, store.catalogNames) })
        continue
      }
      if (catalogVersion > (stored.version ?? 0)) {
        out.push({
          type: 'outdated',
          id,
          name: stored.name,
          fromVersion: stored.version ?? 0,
          toVersion: catalogVersion,
        })
      }
    }
    return out
  })

  const hasIssues = computed(() => issues.value.length > 0)
  const newPresets = computed(() => issues.value.filter((i) => i.type === 'new'))
  const outdated = computed(() => issues.value.filter((i) => i.type === 'outdated'))

  return { issues, hasIssues, newPresets, outdated }
}
