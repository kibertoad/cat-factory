import { ref } from 'vue'
import type {
  ConnectServiceCatalogInput,
  ServiceCatalogConnection,
  ServiceCatalogSyncResult,
} from '~/types/domain'

/**
 * The SERVICE CATALOG half of the foundational-services store: the workspace's connected developer
 * portal, and the four actions over it.
 *
 * A separate factory rather than more of `foundationalServicesSetup`, which had reached its
 * per-function line budget. The seam is the feature's own: this is one connection with one store
 * behind it, where everything else in that setup is the catalog's tiers, its suppressions and its
 * repo sources.
 *
 * It is WORKSPACE-only. The portal credential rides the workspace-keyed secret delegation, so the
 * backend serves this connection at no other scope, and the account-tier store gets the same state
 * declared and permanently unavailable rather than a shape that pretends otherwise.
 */
export interface ServiceCatalogStateDependencies {
  /** The workspace-scoped API calls, narrowed to the five this half makes. */
  api: {
    getServiceCatalog: (workspaceId: string) => Promise<ServiceCatalogConnection | null>
    connectServiceCatalog: (
      workspaceId: string,
      body: ConnectServiceCatalogInput,
    ) => Promise<ServiceCatalogConnection>
    // The contract's 204 sends no body, which the generated client surfaces as `null` rather than
    // `void`; declaring the narrower shape here would refuse the real client.
    disconnectServiceCatalog: (workspaceId: string) => Promise<unknown>
    probeServiceCatalog: (
      workspaceId: string,
      body: ConnectServiceCatalogInput,
    ) => Promise<{ ok: boolean; message?: string }>
    syncServiceCatalog: (workspaceId: string) => Promise<ServiceCatalogSyncResult>
  }
  /** Throws unless this store is the workspace tier; the caller's own guard. */
  requireWorkspaceId: () => string
  /** False on the account tier, where there is no connection to read. */
  isWorkspaceTier: boolean
  /** Reload the catalog views a connect / disconnect / import changed. */
  reloadCatalog: () => Promise<void>
}

export function createServiceCatalogState(deps: ServiceCatalogStateDependencies) {
  const { api, requireWorkspaceId, isWorkspaceTier, reloadCatalog } = deps

  /** The connection, or null when the workspace has none. */
  const serviceCatalog = ref<ServiceCatalogConnection | null>(null)
  /**
   * false when the deployment configured no service-catalog encryption key: the catalog itself
   * works (contracts can be uploaded), and only the portal-import surface 503s. The finer gate,
   * exactly as `sourcesAvailable` is for the GitHub half.
   */
  const serviceCatalogAvailable = ref(true)

  /**
   * Read the connection as part of the store's probe.
   *
   * Its own `try` rather than part of the probe's: a 503 here hides only the import panel, and the
   * catalog read that ran before it already succeeded, so folding the two would report a configured
   * catalog as absent because its optional portal half is not wired.
   */
  async function load(workspaceId: string): Promise<void> {
    if (!isWorkspaceTier) {
      serviceCatalogAvailable.value = false
      return
    }
    try {
      serviceCatalog.value = await api.getServiceCatalog(workspaceId)
      serviceCatalogAvailable.value = true
    } catch {
      serviceCatalog.value = null
      serviceCatalogAvailable.value = false
    }
  }

  /** Clear both views, for a probe whose whole catalog read failed. */
  function reset(): void {
    serviceCatalog.value = null
    serviceCatalogAvailable.value = false
  }

  /**
   * Store the connection. The first import is the CALLER's next step, not part of this promise.
   *
   * A connection that shows nothing reads as a broken one, so an import does follow immediately
   * (the same reason a linked repo source syncs on link). What it must not do is settle this
   * promise: by the time the import runs the connection is already stored, so folding an import
   * failure in here would reject a call that succeeded, and the panel would show a "could not
   * connect" toast beside the connection it just made, hiding the remedy the real failure names.
   */
  async function connect(input: ConnectServiceCatalogInput) {
    serviceCatalog.value = await api.connectServiceCatalog(requireWorkspaceId(), input)
    return serviceCatalog.value
  }

  async function disconnect(): Promise<void> {
    await api.disconnectServiceCatalog(requireWorkspaceId())
    serviceCatalog.value = null
    // Disconnecting TOMBSTONES what the portal produced, so both catalog views are now wrong.
    await reloadCatalog()
  }

  function probe(input: ConnectServiceCatalogInput) {
    return api.probeServiceCatalog(requireWorkspaceId(), input)
  }

  /** Import now, then refresh both catalog views. */
  async function importNow(): Promise<ServiceCatalogSyncResult> {
    const id = requireWorkspaceId()
    const result = await api.syncServiceCatalog(id)
    // The connection is re-read too: the import stamps its verdict there, and that verdict is the
    // only thing that tells a human the estate they are looking at is a PREFIX of the portal's.
    const [connection] = await Promise.all([api.getServiceCatalog(id), reloadCatalog()])
    serviceCatalog.value = connection
    return result
  }

  return {
    serviceCatalog,
    serviceCatalogAvailable,
    load,
    reset,
    connect,
    disconnect,
    probe,
    importNow,
  }
}
