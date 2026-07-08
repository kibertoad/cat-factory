import { computed } from 'vue'
import type { RiskPolicy } from '~/types/merge'
import { useRiskPoliciesStore } from '~/stores/riskPolicies'

export type RiskPolicyIssueType = 'outdated' | 'new'

/** A built-in merge preset that the workspace should reseed (an update, or a new one to add). */
export interface RiskPolicyIssue {
  type: RiskPolicyIssueType
  /** The catalog (built-in) id — what the reseed endpoint is keyed by. */
  id: string
  /** The preset name (the stored copy's for `outdated`, the built-in id for a `new` one). */
  name: string
  /** For an `outdated` issue: the persisted copy's version (the display copy renders it via i18n). */
  fromVersion?: number
  /** For an `outdated` issue: the newer catalog version available. */
  toVersion?: number
}

/** A built-in's display name for an issue message (humanise its catalog id as a fallback). */
function builtinName(id: string, stored: RiskPolicy | undefined): string {
  if (stored) return stored.name
  // `mp_manual_review` -> "Manual review" — only used until the row is reseeded into existence.
  return id.replace(/^mp_/, '').replace(/_/g, ' ')
}

/**
 * Detect built-in merge presets the workspace should reseed for the startup advisory: a stored
 * built-in whose catalog definition moved ahead (offer to adopt it) and a brand-new built-in
 * that appeared in the catalog but isn't in the workspace yet (offer to add it). The catalog
 * versions the snapshot ships ARE the set of built-in ids, so detection is entirely client-side:
 * a stored preset is a built-in iff its id is a catalog key, and a catalog key with no stored
 * preset is a new built-in.
 */
export function useRiskPolicyHealth() {
  const store = useRiskPoliciesStore()

  const issues = computed<RiskPolicyIssue[]>(() => {
    const out: RiskPolicyIssue[] = []
    const byId = new Map(store.presets.map((p) => [p.id, p]))
    for (const [id, catalogVersion] of Object.entries(store.catalogVersions)) {
      const stored = byId.get(id)
      if (!stored) {
        out.push({ type: 'new', id, name: builtinName(id, undefined) })
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
