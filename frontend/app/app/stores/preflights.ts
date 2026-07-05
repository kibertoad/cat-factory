import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { PreflightRef, PreflightResult } from '@cat-factory/contracts'
import { apiErrorStatus } from '~/composables/api/errors'
import { useWorkspaceStore } from '~/stores/workspace'

/**
 * Runs a recipe's preflight checks (machine-prerequisite probes) and exposes the verdicts to the
 * environment setup wizard's checklist. The probes are runtime-bound to the host Docker daemon /
 * filesystem, so they only run on the LOCAL facade — the endpoint 503s elsewhere and
 * `available` latches to `false` (the checklist then shows a "runs on the local machine" note
 * instead of pretending to check). Mirrors the other infra stores' `available: null|boolean` gate.
 */
export const usePreflightsStore = defineStore('preflights', () => {
  const api = useApi()

  // `null` until first probed; `false` ⇒ the host-probe runtime isn't wired (503 — not the local
  // facade), so the wizard's checklist degrades to a note rather than a live check.
  const available = ref<boolean | null>(null)

  /**
   * Run the given preflight refs and return one verdict each. On a 503 (no host-probe runtime)
   * latches `available` to false and returns `null` so the caller can render the degraded note;
   * any other error propagates. An empty ref list short-circuits to `[]` with no request.
   */
  async function run(prerequisites: PreflightRef[]): Promise<PreflightResult[] | null> {
    if (prerequisites.length === 0) {
      available.value = true
      return []
    }
    const ws = useWorkspaceStore()
    try {
      const results = await api.runPreflights(ws.requireId(), prerequisites)
      available.value = true
      return results
    } catch (err) {
      // A 503 means the host-probe runtime isn't wired (non-local facade); surface the degraded
      // state rather than an error. Anything else is a real failure the caller should see.
      if (apiErrorStatus(err) === 503) {
        available.value = false
        return null
      }
      throw err
    }
  }

  return { available, run }
})
