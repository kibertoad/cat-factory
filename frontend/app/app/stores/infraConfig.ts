import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type {
  CustomManifestType,
  EnvironmentHandlerView,
  ProvisionType,
  RegisterEnvironmentHandlerInput,
  UpsertCustomManifestTypeInput,
  UpsertEnvironmentUserHandlerBody,
} from '@cat-factory/contracts'
import { useWorkspaceStore } from '~/stores/workspace'

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

  /** The workspace-defined (UI-editable) custom types, separated from the read-only registered ones. */
  const workspaceCustomTypes = computed(() =>
    customTypes.value.filter((t) => t.source === 'workspace'),
  )
  const registeredCustomTypes = computed(() =>
    customTypes.value.filter((t) => t.source === 'registered'),
  )

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
    return handlers.value.find(
      (h) => h.provisionType === type && (h.manifestId ?? null) === (manifestId ?? null),
    )
  }

  function customTypeById(manifestId: string): CustomManifestType | undefined {
    return customTypes.value.find((t) => t.manifestId === manifestId)
  }

  async function registerHandler(input: RegisterEnvironmentHandlerInput) {
    const ws = useWorkspaceStore()
    const saved = await api.registerEnvironmentHandler(ws.requireId(), input)
    upsertHandlerLocal(saved)
    return saved
  }

  async function updateHandlerSecrets(
    type: ProvisionType,
    secrets: Record<string, string>,
    manifestId?: string | null,
  ) {
    const ws = useWorkspaceStore()
    const saved = await api.updateEnvironmentHandlerSecrets(
      ws.requireId(),
      type,
      secrets,
      manifestId ?? undefined,
    )
    upsertHandlerLocal(saved)
    return saved
  }

  async function unregisterHandler(type: ProvisionType, manifestId?: string | null) {
    const ws = useWorkspaceStore()
    await api.unregisterEnvironmentHandler(ws.requireId(), type, manifestId ?? undefined)
    handlers.value = handlers.value.filter(
      (h) => !(h.provisionType === type && (h.manifestId ?? null) === (manifestId ?? null)),
    )
  }

  function upsertHandlerLocal(saved: EnvironmentHandlerView) {
    const idx = handlers.value.findIndex(
      (h) =>
        h.provisionType === saved.provisionType &&
        (h.manifestId ?? null) === (saved.manifestId ?? null),
    )
    if (idx >= 0) handlers.value[idx] = saved
    else handlers.value.push(saved)
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
    return userHandlers.value.find(
      (h) => h.provisionType === type && (h.manifestId ?? null) === (manifestId ?? null),
    )
  }

  async function upsertUserHandler(type: ProvisionType, body: UpsertEnvironmentUserHandlerBody) {
    const ws = useWorkspaceStore()
    const saved = await api.upsertEnvironmentUserHandler(ws.requireId(), type, body)
    const idx = userHandlers.value.findIndex(
      (h) =>
        h.provisionType === saved.provisionType &&
        (h.manifestId ?? null) === (saved.manifestId ?? null),
    )
    if (idx >= 0) userHandlers.value[idx] = saved
    else userHandlers.value.push(saved)
    return saved
  }

  async function removeUserHandler(type: ProvisionType, manifestId?: string | null) {
    const ws = useWorkspaceStore()
    await api.removeEnvironmentUserHandler(ws.requireId(), type, manifestId ?? undefined)
    userHandlers.value = userHandlers.value.filter(
      (h) => !(h.provisionType === type && (h.manifestId ?? null) === (manifestId ?? null)),
    )
  }

  return {
    handlers,
    customTypes,
    workspaceCustomTypes,
    registeredCustomTypes,
    userHandlers,
    loading,
    available,
    userOverridesAvailable,
    load,
    ensureLoaded,
    handlerFor,
    customTypeById,
    registerHandler,
    updateHandlerSecrets,
    unregisterHandler,
    upsertCustomType,
    removeCustomType,
    loadUserHandlers,
    userHandlerFor,
    upsertUserHandler,
    removeUserHandler,
  }
})
