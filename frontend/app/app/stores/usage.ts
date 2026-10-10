import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { UsageReport } from '@cat-factory/contracts'

/**
 * The workspace's token-usage report for the current billing period (the "Usage" settings
 * tab). Loaded on demand from `GET /workspaces/:ws/usage`; covers BOTH metered API/proxy
 * calls and flat-rate subscription harness usage (Claude Code / Codex / GLM / pooled Kimi &
 * DeepSeek). Reporting only — the spend budget still counts only the metered rows.
 */
export const useUsageStore = defineStore('usage', () => {
  const api = useApi()
  const report = ref<UsageReport | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)

  async function load(ws: string) {
    loading.value = true
    error.value = null
    try {
      report.value = await api.getUsage(ws)
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    } finally {
      loading.value = false
    }
  }

  const rows = computed(() => report.value?.rows ?? [])
  const metered = computed(() => rows.value.filter((r) => r.billing === 'metered'))
  const subscription = computed(() => rows.value.filter((r) => r.billing === 'subscription'))

  /** Summed input/output tokens + cost for a set of rows. */
  function totalOf(list: UsageReport['rows']) {
    return list.reduce(
      (acc, r) => ({
        inputTokens: acc.inputTokens + r.inputTokens,
        outputTokens: acc.outputTokens + r.outputTokens,
        costEstimate: acc.costEstimate + r.costEstimate,
        calls: acc.calls + r.calls,
      }),
      { inputTokens: 0, outputTokens: 0, costEstimate: 0, calls: 0 },
    )
  }

  const meteredTotal = computed(() => totalOf(metered.value))
  const subscriptionTotal = computed(() => totalOf(subscription.value))

  return {
    report,
    loading,
    error,
    load,
    rows,
    metered,
    subscription,
    meteredTotal,
    subscriptionTotal,
  }
})
