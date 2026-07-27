import { defineStore } from 'pinia'
import { ref } from 'vue'
import type {
  CreateAcceptanceCriterionInput,
  ServiceAcceptanceCriteria,
  ServiceAcceptanceCriterion,
  UpdateAcceptanceCriterionInput,
} from '~/types/acceptanceCriteria'
import { useUpsertList } from '~/composables/useUpsertList'
import { useWorkspaceStore } from '~/stores/workspace'

/**
 * Whether a failed load is a SETTLED "you can't have this" — the facade wired no store (503) —
 * rather than a transient fault. Only the settled case latches `available` to false; everything
 * else stays unresolved so a later visit retries.
 *
 * Unlike the neighbouring operator-config stores there is no 403 case to latch: criteria are
 * MEMBER-tier writes gated only by the RBAC viewer write floor, so any user who can see the
 * board can read them.
 */
function isSettledUnavailable(error: unknown): boolean {
  const status =
    error && typeof error === 'object' && 'statusCode' in error
      ? (error as { statusCode?: number }).statusCode
      : undefined
  return status === 503
}

/**
 * The workspace's ACCEPTANCE CRITERIA: per service frame, the durable given/when/outcome
 * statements of required behaviour the service has accumulated. Confirmed criteria ride every
 * dispatch's prompt and earn a per-criterion verdict from the tester; proposed ones are
 * candidates the accretion pass extracted from a settled requirements review, awaiting triage.
 *
 * Loaded on demand by the service inspector rather than from the workspace snapshot — it is
 * curation read on one panel, not something every board load needs.
 */
export const useAcceptanceCriteriaStore = defineStore('acceptanceCriteria', () => {
  const api = useApi()

  const {
    items: byFrame,
    upsert: upsertLocal,
    remove: dropLocal,
  } = useUpsertList<ServiceAcceptanceCriteria>({ key: (entry) => entry.blockId })
  const loading = ref(false)
  /**
   * Mirrors the backend's wiring: `null` until first probed, then true/false. The inspector
   * panel hides itself when false, so a facade that didn't wire the store shows no dead control.
   */
  const available = ref<boolean | null>(null)
  /**
   * Whether the last load failed for a reason that is NOT "no store wired". Rendered by the
   * panel: a swallowed failure leaves an empty list, which reads exactly like a service that has
   * no criteria — the one thing the panel must never say wrongly.
   */
  const failed = ref(false)
  let inFlight: Promise<void> | null = null

  /** Force a refresh of every service frame's criteria (used after a create/update/remove). */
  async function load() {
    const ws = useWorkspaceStore()
    loading.value = true
    try {
      byFrame.value = await api.listServiceAcceptanceCriteria(ws.requireId())
      available.value = true
      failed.value = false
    } catch (error) {
      available.value = isSettledUnavailable(error) ? false : null
      failed.value = !isSettledUnavailable(error)
    } finally {
      loading.value = false
    }
  }

  /** Load once per session; concurrent callers share the in-flight request. */
  async function ensureLoaded(): Promise<void> {
    if (available.value !== null) return
    inFlight ??= load().finally(() => {
      inFlight = null
    })
    return inFlight
  }

  /**
   * What the inspector panel calls when it opens: load if we never have, otherwise REFRESH.
   *
   * A load-once store would be wrong here in a way it isn't for the operator-config stores next
   * door. The panel's primary job is triaging the `proposed` criteria the post-review accretion
   * pass writes DURING a run, and those arrive with no live event and no snapshot entry — so a
   * store that latched after its first success would show the queue as empty until the user
   * reloaded the whole page, which is precisely when they would be looking for it.
   */
  async function refresh(): Promise<void> {
    if (available.value === null) return ensureLoaded()
    if (available.value === false) return
    await (inFlight ??= load().finally(() => {
      inFlight = null
    }))
  }

  /** The criteria recorded for a service frame (an empty list when it has none). */
  function forBlock(blockId: string): ServiceAcceptanceCriterion[] {
    return byFrame.value.find((entry) => entry.blockId === blockId)?.criteria ?? []
  }

  /**
   * Replace one frame's criteria locally after a write. The API returns the single mutated
   * criterion (not the frame's whole list), so the store folds it in itself rather than
   * re-fetching — a triage pass is a rapid sequence of status flips, and a round trip per
   * click would make it feel broken.
   */
  function applyLocal(blockId: string, criterion: ServiceAcceptanceCriterion): void {
    const existing = forBlock(blockId)
    const index = existing.findIndex((c) => c.id === criterion.id)
    const criteria =
      index === -1
        ? [...existing, criterion]
        : existing.map((c) => (c.id === criterion.id ? criterion : c))
    upsertLocal({ blockId, criteria })
  }

  /** Add a criterion to a service frame by hand (it arrives already `confirmed`). */
  async function create(
    blockId: string,
    input: CreateAcceptanceCriterionInput,
  ): Promise<ServiceAcceptanceCriterion> {
    const ws = useWorkspaceStore()
    const created = await api.createServiceAcceptanceCriterion(ws.requireId(), blockId, input)
    applyLocal(blockId, created)
    return created
  }

  /** Patch a criterion — most often a status flip from the triage list. */
  async function update(
    blockId: string,
    criterionId: string,
    input: UpdateAcceptanceCriterionInput,
  ): Promise<ServiceAcceptanceCriterion> {
    const ws = useWorkspaceStore()
    const updated = await api.updateAcceptanceCriterion(ws.requireId(), criterionId, input)
    applyLocal(blockId, updated)
    return updated
  }

  /** Remove a criterion outright. Retiring is usually the better move — it is remembered. */
  async function remove(blockId: string, criterionId: string): Promise<void> {
    const ws = useWorkspaceStore()
    await api.deleteAcceptanceCriterion(ws.requireId(), criterionId)
    const criteria = forBlock(blockId).filter((c) => c.id !== criterionId)
    if (criteria.length === 0) dropLocal(blockId)
    else upsertLocal({ blockId, criteria })
  }

  return {
    byFrame,
    loading,
    available,
    failed,
    load,
    ensureLoaded,
    refresh,
    forBlock,
    create,
    update,
    remove,
  }
})
