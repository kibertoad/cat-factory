import { computed, ref } from 'vue'

/**
 * The guided review store's record of failed background refetches, extracted so the store keeps
 * one job per collaborator. Failures are kept per session, per fetch key (the session itself or
 * one of its threads). A key's entry clears when that key lands again, so a thread landing says
 * nothing about a failed session load, and the other way round.
 */
export function createRefetchFailures() {
  const failedLoads = ref<Record<string, Record<string, unknown>>>({})

  /**
   * Per session, the error of a load that is still failing, so a window can say its view may be
   * out of date. Present while any of the session's failed loads has not landed again.
   */
  const refetchFailures = computed(() => {
    const out: Record<string, unknown> = {}
    for (const [sessionId, byKey] of Object.entries(failedLoads.value)) {
      const errors = Object.values(byKey)
      if (errors.length) out[sessionId] = errors.at(-1)
    }
    return out
  })

  function recordFailure(sessionId: string, key: string, error: unknown) {
    failedLoads.value[sessionId] = { ...failedLoads.value[sessionId], [key]: error }
  }

  function clearFailure(sessionId: string, key: string) {
    const byKey = failedLoads.value[sessionId]
    if (!byKey || !(key in byKey)) return
    const { [key]: _landed, ...rest } = byKey
    if (Object.keys(rest).length) failedLoads.value[sessionId] = rest
    else delete failedLoads.value[sessionId]
  }

  /** Whether the background refetch for `key` failed and has not landed since. */
  function hasFailed(sessionId: string, key: string): boolean {
    return key in (failedLoads.value[sessionId] ?? {})
  }

  function forgetSession(sessionId: string) {
    delete failedLoads.value[sessionId]
  }

  function clearAll() {
    failedLoads.value = {}
  }

  return {
    failedLoads,
    refetchFailures,
    recordFailure,
    clearFailure,
    hasFailed,
    forgetSession,
    clearAll,
  }
}
