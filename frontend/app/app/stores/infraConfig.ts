import { defineStore } from 'pinia'
import { ref, type Ref } from 'vue'
import type {
  CustomManifestType,
  DetectServiceProvisioningInput,
  EnvironmentHandlerView,
  ProvisionType,
  RegisterEnvironmentHandlerInput,
  RepairCustomManifestInput,
  TestEnvironmentHandlerInput,
  UpsertCustomManifestTypeInput,
  UpsertEnvironmentUserHandlerBody,
} from '@cat-factory/contracts'
import { useWorkspaceStore } from '~/stores/workspace'

// One predicate for "this handler is the (type, manifestId) one" — custom handlers are keyed by
// manifestId, the rest by type alone (manifestId null). Defined once and reused across both the
// workspace and per-user handler sets so the match key lives in a single place.
const sameHandler = (h: EnvironmentHandlerView, type: ProvisionType, manifestId?: string | null) =>
  h.provisionType === type && (h.manifestId ?? null) === (manifestId ?? null)

// Replace the matching entry in a handler-list ref, or append it.
function upsertInto(list: Ref<EnvironmentHandlerView[]>, saved: EnvironmentHandlerView) {
  const idx = list.value.findIndex((h) => sameHandler(h, saved.provisionType, saved.manifestId))
  if (idx >= 0) list.value[idx] = saved
  else list.value.push(saved)
}

/**
 * The per-provision-type infra handlers (the workspace + per-user "how"): for each provision
 * type a service can declare, which engine + connection the workspace stands its environment
 * up with, plus the open custom-manifest-type catalog. Loaded on demand (the Infrastructure
 * window's per-type configurator + the service inspector's custom-type picker), not from the
 * snapshot, since the secret bundles never leave the server.
 *
 * The per-USER override handlers (`userHandlers`) are local mode only — the backend service is
 * wired solely by the local facade, so the endpoints 503 elsewhere and `userOverridesAvailable`
 * stays false (the override affordance hides).
 */
export const useInfraConfigStore = defineStore('infraConfig', () => {
  const api = useApi()

  const handlers = ref<EnvironmentHandlerView[]>([])
  const customTypes = ref<CustomManifestType[]>([])
  const userHandlers = ref<EnvironmentHandlerView[]>([])
  const loading = ref(false)
  // `null` until first probed; `false` ⇒ the test-env handler integration is off (503),
  // so the configurator hides. Mirrors the other infra stores' availability gate.
  const available = ref<boolean | null>(null)
  // Per-user overrides probe independently (local mode only).
  const userOverridesAvailable = ref<boolean | null>(null)
  let inFlight: Promise<void> | null = null

  /** Force a refresh of the workspace handler bundle (used after a save/remove). */
  async function load() {
    const ws = useWorkspaceStore()
    loading.value = true
    try {
      const bundle = await api.listEnvironmentHandlers(ws.requireId())
      handlers.value = bundle.handlers
      customTypes.value = bundle.customTypes
      available.value = true
    } catch {
      // 503 (environments integration off) or any error → hide the configurator.
      available.value = false
      handlers.value = []
      customTypes.value = []
    } finally {
      loading.value = false
    }
  }

  /**
   * Load once and share the result: repeated window opens / inspector mounts reuse the
   * resolved state (and coalesce a concurrent in-flight request). Use `load()` to force a
   * refresh. The custom-type catalog feeds the service inspector's `custom` picker, so this
   * is also called there (cheaply) to populate it.
   */
  async function ensureLoaded() {
    if (available.value !== null) return
    if (!inFlight) inFlight = load().finally(() => (inFlight = null))
    return inFlight
  }

  /** The workspace handler matching a provision type (+ manifest id, for `custom`), if registered. */
  function handlerFor(
    type: ProvisionType,
    manifestId?: string | null,
  ): EnvironmentHandlerView | undefined {
    return handlers.value.find((h) => sameHandler(h, type, manifestId))
  }

  async function registerHandler(input: RegisterEnvironmentHandlerInput) {
    const ws = useWorkspaceStore()
    const saved = await api.registerEnvironmentHandler(ws.requireId(), input)
    upsertInto(handlers, saved)
    return saved
  }

  /** Probe a candidate handler connection before saving (nothing persisted). */
  async function testHandler(input: TestEnvironmentHandlerInput) {
    const ws = useWorkspaceStore()
    return api.testEnvironmentHandler(ws.requireId(), input)
  }

  /**
   * Auto-detect a NON-BINDING recommended provisioning config from a service's repo. The SPA
   * prefills the confirm form from the result; nothing is persisted server-side. Detection is
   * pure repo introspection, so it works regardless of which handlers are registered.
   */
  async function detectProvisioning(input: DetectServiceProvisioningInput) {
    const ws = useWorkspaceStore()
    return api.detectServiceProvisioning(ws.requireId(), input)
  }

  /**
   * Generate (or fix) a service's custom manifest via the fixer coding agent. Dispatches a
   * durable async repair run and returns immediately with `usedAgent`/`repairJobId`; the run is
   * tracked via the workspace stream like the provider-config repair. Nothing persisted here.
   */
  async function repairCustomManifest(input: RepairCustomManifestInput) {
    const ws = useWorkspaceStore()
    return api.repairCustomManifest(ws.requireId(), input)
  }

  async function unregisterHandler(type: ProvisionType, manifestId?: string | null) {
    const ws = useWorkspaceStore()
    await api.unregisterEnvironmentHandler(ws.requireId(), type, manifestId ?? undefined)
    handlers.value = handlers.value.filter((h) => !sameHandler(h, type, manifestId))
  }

  // ---- Custom-manifest-type catalog CRUD (workspace-defined entries only) ----
  async function upsertCustomType(manifestId: string, input: UpsertCustomManifestTypeInput) {
    const ws = useWorkspaceStore()
    const saved = await api.upsertCustomManifestType(ws.requireId(), manifestId, input)
    const idx = customTypes.value.findIndex((t) => t.manifestId === saved.manifestId)
    if (idx >= 0) customTypes.value[idx] = saved
    else customTypes.value.push(saved)
    return saved
  }

  async function removeCustomType(manifestId: string) {
    const ws = useWorkspaceStore()
    await api.removeCustomManifestType(ws.requireId(), manifestId)
    customTypes.value = customTypes.value.filter((t) => t.manifestId !== manifestId)
  }

  // ---- Per-user override handlers (local mode) ------------------------------
  async function loadUserHandlers() {
    const ws = useWorkspaceStore()
    try {
      const { handlers: list } = await api.listEnvironmentUserHandlers(ws.requireId())
      userHandlers.value = list
      userOverridesAvailable.value = true
    } catch {
      // 503 (not the local facade) / not signed in → no per-user overrides surface.
      userOverridesAvailable.value = false
      userHandlers.value = []
    }
  }

  function userHandlerFor(
    type: ProvisionType,
    manifestId?: string | null,
  ): EnvironmentHandlerView | undefined {
    return userHandlers.value.find((h) => sameHandler(h, type, manifestId))
  }

  async function upsertUserHandler(type: ProvisionType, body: UpsertEnvironmentUserHandlerBody) {
    const ws = useWorkspaceStore()
    const saved = await api.upsertEnvironmentUserHandler(ws.requireId(), type, body)
    upsertInto(userHandlers, saved)
    return saved
  }

  async function removeUserHandler(type: ProvisionType, manifestId?: string | null) {
    const ws = useWorkspaceStore()
    await api.removeEnvironmentUserHandler(ws.requireId(), type, manifestId ?? undefined)
    userHandlers.value = userHandlers.value.filter((h) => !sameHandler(h, type, manifestId))
  }

  return {
    handlers,
    customTypes,
    userHandlers,
    loading,
    available,
    userOverridesAvailable,
    load,
    ensureLoaded,
    handlerFor,
    registerHandler,
    testHandler,
    detectProvisioning,
    repairCustomManifest,
    unregisterHandler,
    upsertCustomType,
    removeCustomType,
    loadUserHandlers,
    userHandlerFor,
    upsertUserHandler,
    removeUserHandler,
  }
})
