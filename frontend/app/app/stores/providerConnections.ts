import { defineStore } from 'pinia'
import { computed, reactive, ref } from 'vue'
import type { BackendKindOption } from '@cat-factory/contracts'
import type {
  ProviderConnection,
  ProviderConnectionKind,
  ProviderDescriptor,
  RegisterProviderInput,
  TestProviderInput,
} from '~/types/providerConnections'
import { useWorkspaceStore } from '~/stores/workspace'

const KINDS: ProviderConnectionKind[] = ['environment', 'runner-pool']

// Built-in fallback so the connect form's backend selector works before the snapshot
// loads (or on an older backend that doesn't advertise the kinds). The live lists come
// from the workspace snapshot (`environmentBackendKinds` / `runnerBackendKinds`) and may
// additionally carry a deployment's programmatically-registered CUSTOM kinds.
const BUILTIN_BACKEND_KINDS: Record<ProviderConnectionKind, BackendKindOption[]> = {
  environment: [
    { kind: 'manifest', label: 'HTTP manifest', engines: ['remote-custom'] },
    { kind: 'kubernetes', label: 'Kubernetes', engines: ['local-k3s', 'remote-kubernetes'] },
  ],
  'runner-pool': [
    { kind: 'manifest', label: 'HTTP manifest pool' },
    { kind: 'kubernetes', label: 'Kubernetes' },
  ],
}

interface ProviderState {
  /** null until first probed; false ⇒ integration disabled on the backend (hide it). */
  available: boolean | null
  descriptor: ProviderDescriptor | null
  connection: ProviderConnection | null
}

function emptyState(): ProviderState {
  return { available: null, descriptor: null, connection: null }
}

/**
 * The two infrastructure providers configured through the generic connect form — the
 * ephemeral-environment provider and the self-hosted runner pool. Each exposes a
 * self-describing `ProviderDescriptor` (fields + defaults + the `missingRequired` keys the
 * org still has to supply) plus the saved connection metadata (never secret values). Loaded
 * on demand: the banner probes both eagerly so it can warn when a provider is wired for the
 * instance but mandatory fields are missing; the panel re-loads its own kind on open.
 */
export const useProviderConnectionsStore = defineStore('providerConnections', () => {
  const api = useApi()
  const state = reactive<Record<ProviderConnectionKind, ProviderState>>({
    environment: emptyState(),
    'runner-pool': emptyState(),
  })
  const loaded = ref(false)
  let inFlight: Promise<void> | null = null
  // The selectable backend kinds per subsystem, fed from the workspace snapshot.
  const backendKinds = reactive<Record<ProviderConnectionKind, BackendKindOption[]>>({
    environment: BUILTIN_BACKEND_KINDS.environment,
    'runner-pool': BUILTIN_BACKEND_KINDS['runner-pool'],
  })

  /** Seed the backend-kind selector lists from the workspace snapshot (built-in + custom). */
  function registerBackendKinds(
    payload: Partial<Record<ProviderConnectionKind, BackendKindOption[]>>,
  ) {
    for (const kind of KINDS) {
      const list = payload[kind]
      if (list && list.length > 0) backendKinds[kind] = list
    }
  }

  /** The selectable backend kinds for a subsystem (built-in fallback until the snapshot loads). */
  function backendKindsFor(kind: ProviderConnectionKind): BackendKindOption[] {
    return backendKinds[kind]
  }

  // `backendKind` (optional) re-probes the descriptor for a specific (e.g. not-yet-connected
  // custom) backend kind, so its connect form renders before the first connect.
  async function loadKind(kind: ProviderConnectionKind, backendKind?: string) {
    const ws = useWorkspaceStore()
    const s = state[kind]
    try {
      const [descriptor, { connection }] = await Promise.all([
        api.describeProvider(ws.requireId(), kind, backendKind),
        api.getProviderConnection(ws.requireId(), kind),
      ])
      s.descriptor = descriptor
      s.connection = connection
      s.available = true
    } catch {
      // 503 (integration disabled) or any error → hide this provider's UI entry points.
      s.available = false
      s.descriptor = null
      s.connection = null
    }
  }

  /**
   * Re-probe ONLY the descriptor for a specific backend kind (e.g. a not-yet-connected
   * custom kind the user just picked), leaving the stored connection untouched. Switching
   * the selector must NOT re-fetch the connection: that would reassign `state.connection`
   * and bounce the selector back to the stored kind via the component's `connection` watch.
   */
  async function loadDescriptor(kind: ProviderConnectionKind, backendKind?: string) {
    const ws = useWorkspaceStore()
    try {
      state[kind].descriptor = await api.describeProvider(ws.requireId(), kind, backendKind)
    } catch {
      // Keep the existing descriptor/availability on a transient describe failure.
    }
  }

  /**
   * Fetch (without mutating shared state) the descriptor for a specific backend kind — used by
   * the per-type infra configurator to prefill a custom backend's manifest template/secret
   * fields when the operator picks it. Returns null on a transient describe failure.
   */
  async function fetchDescriptor(
    kind: ProviderConnectionKind,
    backendKind?: string,
  ): Promise<ProviderDescriptor | null> {
    const ws = useWorkspaceStore()
    try {
      return await api.describeProvider(ws.requireId(), kind, backendKind)
    } catch {
      return null
    }
  }

  /** Refresh both providers (used by the banner + after a save/remove). */
  async function load() {
    await Promise.all(KINDS.map((k) => loadKind(k)))
    loaded.value = true
  }

  /** Load once and share the result (coalescing concurrent callers). */
  async function ensureLoaded() {
    if (loaded.value) return
    if (!inFlight) inFlight = load().finally(() => (inFlight = null))
    return inFlight
  }

  function descriptorFor(kind: ProviderConnectionKind): ProviderDescriptor | null {
    return state[kind].descriptor
  }
  function connectionFor(kind: ProviderConnectionKind): ProviderConnection | null {
    return state[kind].connection
  }
  function isAvailable(kind: ProviderConnectionKind): boolean {
    return state[kind].available === true
  }

  /**
   * Providers that are wired for this instance but still missing mandatory config —
   * exactly what the loud banner surfaces. A provider with no config fields at all (a
   * stock manifest provider with nothing authored yet) is NOT flagged: there is nothing
   * to nag about until someone introduces a provider that declares required fields.
   */
  const needingConfig = computed<ProviderConnectionKind[]>(() =>
    KINDS.filter((kind) => {
      const d = state[kind].descriptor
      return state[kind].available === true && !!d && d.missingRequired.length > 0
    }),
  )

  async function register(kind: ProviderConnectionKind, input: RegisterProviderInput) {
    const ws = useWorkspaceStore()
    state[kind].connection = await api.registerProviderConnection(ws.requireId(), kind, input)
    await loadKind(kind) // refresh missingRequired/descriptor after the change
  }

  async function updateSecrets(kind: ProviderConnectionKind, secrets: Record<string, string>) {
    const ws = useWorkspaceStore()
    state[kind].connection = await api.updateProviderSecrets(ws.requireId(), kind, secrets)
    await loadKind(kind)
  }

  async function test(kind: ProviderConnectionKind, input: TestProviderInput) {
    const ws = useWorkspaceStore()
    return api.testProviderConnection(ws.requireId(), kind, input)
  }

  async function remove(kind: ProviderConnectionKind) {
    const ws = useWorkspaceStore()
    await api.deleteProviderConnection(ws.requireId(), kind)
    state[kind].connection = null
    await loadKind(kind)
  }

  return {
    state,
    loaded,
    load,
    loadKind,
    loadDescriptor,
    fetchDescriptor,
    ensureLoaded,
    descriptorFor,
    connectionFor,
    isAvailable,
    needingConfig,
    backendKindsFor,
    registerBackendKinds,
    register,
    updateSecrets,
    test,
    remove,
  }
})
