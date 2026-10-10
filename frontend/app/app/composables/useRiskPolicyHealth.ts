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
 *
 * Asked of the WORKSPACE tier alone. Reseeding writes a board-owned row, so only a board-owned row
 * can be out of date, and only an id no tier resolves is genuinely missing (ADR 0055).
 */
export function useRiskPolicyHealth() {
  const store = useRiskPoliciesStore()

  const issues = computed<RiskPolicyIssue[]>(() => {
    const out: RiskPolicyIssue[] = []
    // The BOARD'S OWN rows only. Since ADR 0055 `presets` is the merged two-tier library, and an
    // account entry carries no `version`, so indexing the merge read an account policy that happens
    // to use a catalog id as a stored built-in stuck at version 0 — an advisory whose reseed would
    // have written a board-owned row shadowing the account's deliberate posture.
    const own = store.presets.filter((p) => p.tier === 'workspace')
    const byId = new Map(own.map((p) => [p.id, p]))
    const inheritedIds = new Set(store.presets.filter((p) => p.tier === 'account').map((p) => p.id))
    for (const [id, catalogVersion] of Object.entries(store.catalogVersions)) {
      const stored = byId.get(id)
      if (!stored) {
        // A built-in the board does not hold, that its ACCOUNT defines, is not missing: the board
        // already resolves a policy under that id. Adding the catalog copy would shadow it, so the
        // advisory stays silent rather than offering a one-click override of the org's choice.
        if (inheritedIds.has(id)) continue
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
