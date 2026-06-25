import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { ModelCost, ModelOption, SubscriptionVendor } from '~/types/domain'

/** The flavour of a model to actually display/run, given configured subscriptions. */
export interface DisplayFlavor {
  providerLabel: string
  provider: string
  model: string
  contextTokens?: number
  cost?: ModelCost
  /** True ⇒ flat-rate quota; its cost is a quota burn rate, not budget spend. */
  quotaBased: boolean
  vendor?: SubscriptionVendor
}

/**
 * The flavour a model resolves to in the picker given the workspace's configured
 * subscription vendors. A dual-mode model (GLM/Kimi) collapses to its subscription
 * flavour once that vendor is connected ("subscriptions always win"); otherwise the
 * base (cloudflare/direct, or the subscription itself for subscription-only models).
 */
export function displayFlavor(m: ModelOption, configured: Set<SubscriptionVendor>): DisplayFlavor {
  if (m.subscription && configured.has(m.subscription.vendor)) {
    return {
      providerLabel: m.subscription.providerLabel,
      provider: m.subscription.provider,
      model: m.subscription.model,
      contextTokens: m.subscription.contextTokens,
      cost: m.subscription.cost,
      quotaBased: true,
      vendor: m.subscription.vendor,
    }
  }
  return {
    providerLabel: m.providerLabel,
    provider: m.provider,
    model: m.model,
    contextTokens: m.contextTokens,
    cost: m.cost,
    quotaBased: m.quotaBased ?? false,
    vendor: m.vendor,
  }
}

/**
 * Whether a model is selectable. On the per-workspace catalog the backend already
 * computes `available` from the configured API keys / subscriptions / Cloudflare opt-in,
 * so honour it directly. On the deployment catalog (`available` absent) fall back to the
 * subscription-token heuristic so the picker still gates subscription-only models.
 */
export function isSelectable(m: ModelOption, configured: Set<SubscriptionVendor>): boolean {
  if (m.available !== undefined) return m.available
  if (m.flavor === 'subscription' && m.vendor) return configured.has(m.vendor)
  return true
}

/** Compact context-window label, e.g. `200K`. */
export function contextLabel(tokens: number | undefined): string | undefined {
  if (!tokens) return undefined
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}K` : `${tokens}`
}

/** One-line cost/quota suffix for the picker. */
export function costLabel(flavor: DisplayFlavor): string | undefined {
  if (!flavor.cost) return undefined
  const { inputPerMillion, outputPerMillion, currency } = flavor.cost
  const body = `${inputPerMillion}/${outputPerMillion} ${currency} per Mtok`
  return flavor.quotaBased ? `quota burn ~${body}` : body
}

/**
 * The model picker catalog. Served by `GET /models`, where each model is already
 * resolved to the flavour in use for this deployment (direct when the provider's
 * key is configured, else the Cloudflare fallback). Fetched once and cached for
 * the per-block picker, and used to label which model produced a step's output.
 */
export const useModelsStore = defineStore('models', () => {
  const api = useApi()
  const models = ref<ModelOption[]>([])
  const loaded = ref(false)
  const loadedWorkspaceId = ref<string | null>(null)

  /**
   * Fetch the catalog. Pass a `workspaceId` for the per-workspace catalog (selectability
   * reflects that workspace's configured keys/subscriptions); re-fetches when the
   * workspace changes. Without one, the deployment-level catalog is loaded once.
   */
  async function ensureLoaded(workspaceId?: string) {
    if (workspaceId) {
      if (loaded.value && loadedWorkspaceId.value === workspaceId) return
      models.value = await api.getWorkspaceModels(workspaceId)
      loadedWorkspaceId.value = workspaceId
      loaded.value = true
      return
    }
    if (loaded.value) return
    models.value = await api.getModels()
    loaded.value = true
  }

  /** Force a re-fetch of the per-workspace catalog (e.g. after adding an API key). */
  async function refresh(workspaceId: string) {
    models.value = await api.getWorkspaceModels(workspaceId)
    loadedWorkspaceId.value = workspaceId
    loaded.value = true
  }

  const byId = computed(() => {
    const map = new Map<string, ModelOption>()
    for (const m of models.value) map.set(m.id, m)
    return map
  })

  function getModel(id: string | undefined) {
    return id ? byId.value.get(id) : undefined
  }

  /**
   * Whether the workspace has at least one usable AI model source right now. The
   * per-workspace catalog already resolves `available` from the configured keys /
   * subscriptions / Cloudflare opt-in / local runners, so this is the single signal for
   * "is any AI configured at all". Only meaningful once the per-workspace catalog has
   * loaded (`loadedWorkspaceId` set); the deployment catalog leaves `available` undefined.
   */
  const hasUsableModel = computed(() => models.value.some((m) => m.available === true))

  /**
   * Whether a specific catalog model id is usable under the current configuration. An id
   * absent from the catalog (e.g. a model that was removed) counts as not usable.
   */
  function isUsableId(id: string): boolean {
    return byId.value.get(id)?.available === true
  }

  /**
   * Friendly label for a recorded `provider:model` identifier (as carried on a
   * pipeline step). Matches it against the catalog's effective refs; falls back
   * to the bare model id for anything not in the catalog (e.g. a pinned override).
   */
  function labelForRef(ref: string | undefined): string | undefined {
    if (!ref) return undefined
    const idx = ref.indexOf(':')
    const provider = idx === -1 ? ref : ref.slice(0, idx)
    const model = idx === -1 ? '' : ref.slice(idx + 1)
    const hit = models.value.find((m) => m.provider === provider && m.model === model)
    return hit ? `${hit.label} · ${hit.providerLabel}` : model || ref
  }

  return {
    models,
    loaded,
    loadedWorkspaceId,
    ensureLoaded,
    refresh,
    byId,
    getModel,
    hasUsableModel,
    isUsableId,
    labelForRef,
  }
})
