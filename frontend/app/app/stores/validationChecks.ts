import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { ServiceValidationConfig, ValidationCheck } from '~/types/validationChecks'
import { VALIDATION_DEFAULT_MAX_ATTEMPTS } from '~/types/validationChecks'
import { useUpsertList } from '~/composables/useUpsertList'
import { useWorkspaceStore } from '~/stores/workspace'

/**
 * The workspace's PRE-PR VALIDATION CHECKS: per service frame, the shell commands the
 * executor-harness runs against the checkout after the coder settles and BEFORE the PR opens.
 * A failing command is fed back into the agent loop; only a green checkout opens a PR.
 *
 * Loaded on demand by the service inspector rather than from the workspace snapshot — it's
 * operator configuration read on one panel, not something every board load needs.
 */
export const useValidationChecksStore = defineStore('validationChecks', () => {
  const api = useApi()

  const {
    items: configs,
    upsert: upsertLocal,
    remove: dropLocal,
  } = useUpsertList<ServiceValidationConfig>({ key: (c) => c.blockId })
  const loading = ref(false)
  /**
   * Mirrors the backend's wiring: `null` until first probed, then true/false. The inspector
   * panel hides itself when false, so a facade that didn't wire the store shows no dead control.
   */
  const available = ref<boolean | null>(null)
  let inFlight: Promise<void> | null = null

  /** Force a refresh of every configured service's checks (used after a save/remove). */
  async function load() {
    const ws = useWorkspaceStore()
    loading.value = true
    try {
      configs.value = await api.listServiceValidationConfigs(ws.requireId())
      available.value = true
    } catch {
      // 503 (store not wired) or any error → hide the UI entry point.
      available.value = false
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

  /** The checks configured for a service frame (an empty default when it has none). */
  function forBlock(blockId: string): ServiceValidationConfig {
    return (
      configs.value.find((c) => c.blockId === blockId) ?? {
        blockId,
        checks: [],
        maxAttempts: VALIDATION_DEFAULT_MAX_ATTEMPTS,
      }
    )
  }

  /**
   * Save a service frame's checks. An EMPTY list clears the config on the backend (the service
   * deletes the row), which restores the exact pre-feature behaviour — so the local list drops
   * the entry rather than keeping an empty one that reads as "configured".
   */
  async function save(
    blockId: string,
    checks: ValidationCheck[],
    maxAttempts: number,
  ): Promise<void> {
    const ws = useWorkspaceStore()
    const saved = await api.setServiceValidationConfig(ws.requireId(), blockId, {
      checks,
      maxAttempts,
    })
    if (saved.checks.length === 0) dropLocal(blockId)
    else upsertLocal(saved)
  }

  /** Remove a service frame's checks entirely. */
  async function remove(blockId: string): Promise<void> {
    const ws = useWorkspaceStore()
    await api.deleteServiceValidationConfig(ws.requireId(), blockId)
    dropLocal(blockId)
  }

  return { configs, loading, available, load, ensureLoaded, forBlock, save, remove }
})
