import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type {
  RiskPolicyLibraryEntry,
  RiskPolicySuppression,
  UpdateRiskPolicyInput,
} from '~/types/merge'
import { useWorkspaceStore } from '~/stores/workspace'

/**
 * The board's risk policy library — what a task picks its auto-merge policy from (the `merger` step
 * compares the PR assessment against the resolved policy).
 *
 * Since ADR 0055 the list is the MERGE of two tiers: the board's own policies and the ones it
 * inherits from its account, each entry carrying the `tier` that owns it. An inherited entry is
 * read-only here and offers two actions instead of an edit — clone it into the board, or hide it —
 * and the backend refuses the writes as well, so the affordances and the rules agree.
 *
 * Hydrated from the workspace snapshot, which carries the same merged list.
 */
export const useRiskPoliciesStore = defineStore('riskPolicies', () => {
  const api = useApi()

  const presets = ref<RiskPolicyLibraryEntry[]>([])
  /**
   * Current built-in catalog versions (`seedRiskPolicies()`), keyed by preset id, from the
   * workspace snapshot. The keys ARE the set of built-in ids: a stored preset whose id is a
   * key here is a built-in (and is outdated when its `version` is below the catalog value),
   * and a key with no matching stored preset is a NEW built-in the workspace can add. Drives
   * `useRiskPolicyHealth`.
   */
  const catalogVersions = ref<Record<string, number>>({})
  /**
   * The account policies this board is HIDING. Loaded on demand rather than from the snapshot: a
   * hidden policy is by construction absent from `presets`, so this is the only way back, and it is
   * read when the settings panel opens rather than on every board load.
   */
  const suppressions = ref<RiskPolicySuppression[]>([])

  /**
   * Adopt the server's list AS SENT, never re-sorted.
   *
   * `mergeRiskPolicyTiers` answers oldest-first within each tier with the ACCOUNT tier first, and
   * both repositories order by `created_at`, so the order already carries the tier grouping every
   * reader wants. Re-sorting the merged list by timestamp interleaved the two, which the settings
   * panel hid by re-splitting per tier and the task picker showed as inherited and own policies
   * shuffled together.
   */
  function hydrate(list: RiskPolicyLibraryEntry[], versions?: Record<string, number>) {
    presets.value = [...list]
    if (versions) catalogVersions.value = versions
  }

  /** The workspace default (fallback for a task that picks none). */
  const defaultPreset = computed(() => presets.value.find((p) => p.isDefault) ?? null)

  /** Resolve a task's effective preset by id, falling back to the default. */
  function resolve(presetId: string | undefined): RiskPolicyLibraryEntry | null {
    if (presetId) {
      const picked = presets.value.find((p) => p.id === presetId)
      if (picked) return picked
    }
    return defaultPreset.value
  }

  async function create(input: Parameters<typeof api.createRiskPolicy>[2]) {
    const ws = useWorkspaceStore()
    const created = await api.createRiskPolicy('workspace', ws.requireId(), input)
    await ws.refresh()
    return created
  }

  async function update(presetId: string, patch: UpdateRiskPolicyInput) {
    const ws = useWorkspaceStore()
    const updated = await api.updateRiskPolicy('workspace', ws.requireId(), presetId, patch)
    await ws.refresh()
    return updated
  }

  async function remove(presetId: string) {
    const ws = useWorkspaceStore()
    await api.deleteRiskPolicy('workspace', ws.requireId(), presetId)
    await ws.refresh()
  }

  /**
   * Reseed a built-in preset from the backend's current catalog: adopt an updated definition,
   * repair a drifted one, or materialise a NEW built-in that appeared after the workspace was
   * created. The `presetId` is the catalog id (e.g. `mp_balanced`). Refreshes the snapshot.
   */
  async function reseed(presetId: string) {
    const ws = useWorkspaceStore()
    const updated = await api.reseedRiskPolicy(ws.requireId(), presetId)
    await ws.refresh()
    return updated
  }

  /**
   * Copy an inherited account policy into the board, under a fresh id, so the board can edit it.
   * `name` is supplied by the caller because the label is localized copy and the backend does not
   * localize prose.
   */
  async function clone(presetId: string, name?: string) {
    const ws = useWorkspaceStore()
    const created = await api.cloneRiskPolicy(ws.requireId(), presetId, name ? { name } : {})
    await ws.refresh()
    return created
  }

  /** Hide an inherited account policy from this board, then re-read what is hidden. */
  async function hide(presetId: string) {
    const ws = useWorkspaceStore()
    await api.suppressRiskPolicy(ws.requireId(), presetId)
    await Promise.all([ws.refresh(), loadSuppressions()])
  }

  /** Stop hiding one, so the board offers it again. */
  async function unhide(presetId: string) {
    const ws = useWorkspaceStore()
    await api.restoreRiskPolicy(ws.requireId(), presetId)
    await Promise.all([ws.refresh(), loadSuppressions()])
  }

  async function loadSuppressions() {
    const ws = useWorkspaceStore()
    suppressions.value = await api.listRiskPolicySuppressions(ws.requireId())
  }

  return {
    presets,
    catalogVersions,
    suppressions,
    defaultPreset,
    resolve,
    hydrate,
    create,
    update,
    remove,
    reseed,
    clone,
    hide,
    unhide,
    loadSuppressions,
  }
})

/**
 * The ACCOUNT tier of the same library: the postures an org authors once, which every board under
 * it inherits (ADR 0055).
 *
 * Its own store rather than a scope flag on the one above, because the two have different lifetimes
 * and different sources of truth: the board library rides the workspace snapshot and refreshes with
 * it, while the account library is loaded on demand by the account settings panel and has no
 * snapshot to fold into. Keyed by account id so switching accounts cannot show the previous one's
 * policies.
 */
export const useAccountRiskPoliciesStore = defineStore('accountRiskPolicies', () => {
  const api = useApi()

  const byAccount = ref<Record<string, RiskPolicyLibraryEntry[]>>({})
  const loading = ref(false)

  const policies = (accountId: string) => byAccount.value[accountId] ?? []

  async function load(accountId: string) {
    loading.value = true
    try {
      byAccount.value = {
        ...byAccount.value,
        [accountId]: await api.listRiskPolicies('account', accountId),
      }
    } finally {
      loading.value = false
    }
  }

  async function create(accountId: string, input: Parameters<typeof api.createRiskPolicy>[2]) {
    const created = await api.createRiskPolicy('account', accountId, input)
    await load(accountId)
    return created
  }

  async function update(accountId: string, presetId: string, patch: UpdateRiskPolicyInput) {
    const updated = await api.updateRiskPolicy('account', accountId, presetId, patch)
    await load(accountId)
    return updated
  }

  async function remove(accountId: string, presetId: string) {
    await api.deleteRiskPolicy('account', accountId, presetId)
    await load(accountId)
  }

  return { policies, loading, load, create, update, remove }
})
