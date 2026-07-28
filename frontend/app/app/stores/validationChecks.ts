import { defineStore } from 'pinia'
import { ref } from 'vue'
import type {
  DetectedValidationChecks,
  ServiceValidationConfig,
  ValidationCheck,
} from '~/types/validationChecks'
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
/**
 * Whether a failed load is a SETTLED "you can't have this" — the facade wired no store (503) or
 * this user lacks `settings.manage` (403) — rather than a transient fault. Only the settled cases
 * latch `available` to false; everything else stays unresolved so a later visit retries.
 */
function isSettledUnavailable(error: unknown): boolean {
  const status =
    error && typeof error === 'object' && 'statusCode' in error
      ? (error as { statusCode?: number }).statusCode
      : undefined
  return status === 503 || status === 403
}

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
    } catch (error) {
      // A 503 means the facade wired no store and a 403 means this user may not manage settings:
      // both are STABLE answers, so latch them and hide the entry point rather than showing a
      // dead control. Anything else (a network blip, a 5xx) is TRANSIENT — leaving `available`
      // unresolved so the next `ensureLoaded` retries, instead of hiding the panel for the rest
      // of the session over one dropped request.
      available.value = isSettledUnavailable(error) ? false : null
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

  /**
   * Ask the backend what this service's repo implies. Nothing is stored: the suggestion goes
   * into the panel's unsaved rows, so the operator reviews and saves it like anything they
   * typed. Deliberately NOT folded into `configs` — a suggestion that looked like saved
   * config would report a service as configured when no run would run a single command.
   */
  async function detect(blockId: string): Promise<DetectedValidationChecks> {
    const ws = useWorkspaceStore()
    return api.detectServiceValidationChecks(ws.requireId(), blockId)
  }

  return { configs, loading, available, load, ensureLoaded, forBlock, save, remove, detect }
})
