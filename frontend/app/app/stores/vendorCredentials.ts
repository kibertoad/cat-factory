import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { SubscriptionVendor, VendorCredential } from '~/types/domain'

/**
 * The workspace's connected LLM-vendor subscription credentials (the token pool
 * powering the Claude Code / Codex harnesses). Loaded from
 * `GET /workspaces/:ws/vendor-credentials`; tokens are write-only so only
 * metadata + rolling-window usage is ever returned. `configuredVendors` drives
 * the model picker: a dual-mode model (GLM/Kimi) collapses to its subscription
 * flavour, and a subscription-only model is enabled, once its vendor is here.
 */
export const useVendorCredentialsStore = defineStore('vendorCredentials', () => {
  const api = useApi()
  const credentials = ref<VendorCredential[]>([])
  const workspaceId = ref<string | null>(null)
  const loading = ref(false)

  async function load(ws: string) {
    workspaceId.value = ws
    loading.value = true
    try {
      const { credentials: list } = await api.listVendorCredentials(ws)
      credentials.value = list
    } finally {
      loading.value = false
    }
  }

  async function add(input: { vendor: SubscriptionVendor; label: string; token: string }) {
    if (!workspaceId.value) return
    const created = await api.addVendorCredential(workspaceId.value, input)
    credentials.value = [...credentials.value, created]
  }

  async function remove(id: string) {
    if (!workspaceId.value) return
    await api.removeVendorCredential(workspaceId.value, id)
    credentials.value = credentials.value.filter((c) => c.id !== id)
  }

  /** The set of vendors with at least one connected token. */
  const configuredVendors = computed(() => new Set(credentials.value.map((c) => c.vendor)))

  function hasVendor(vendor: SubscriptionVendor | undefined): boolean {
    return vendor ? configuredVendors.value.has(vendor) : false
  }

  function forVendor(vendor: SubscriptionVendor) {
    return credentials.value.filter((c) => c.vendor === vendor)
  }

  return { credentials, loading, load, add, remove, configuredVendors, hasVendor, forVendor }
})
