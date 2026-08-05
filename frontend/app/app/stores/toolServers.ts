import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { ToolServerProbeResult, ToolServersView } from '~/types/toolServers'
import { useWorkspaceStore } from '~/stores/workspace'
import { apiErrorStatus } from '~/composables/api/errors'

/**
 * The deployment's tool servers (MCP) and the results of probing them.
 *
 * Two halves with different lifetimes, which is why they are separate refs. The INVENTORY is
 * deployment code: it changes when the deployment redeploys, so it is loaded on demand and re-read
 * rather than patched. A PROBE RESULT is a moment in time and belongs to the operator who asked for
 * it, so results are kept per server id and never fetched eagerly — a probe spends an outbound
 * request under the deployment's own credential, so opening a panel must not fire one.
 *
 * Mirrors the capability-credential store's availability handling deliberately: the two surfaces sit
 * in one tab, gate on the same permission, and a member without it must see neither.
 */
export const useToolServersStore = defineStore('toolServers', () => {
  const api = useApi()

  const view = ref<ToolServersView | null>(null)
  // Probe results by server id. Kept after a re-read of the inventory: a result describes the server
  // rather than the list it arrived in, and dropping it on refresh would erase the answer the
  // operator just asked for.
  const results = ref<Record<string, ToolServerProbeResult>>({})
  const probing = ref<string | null>(null)
  // The server whose OAuth grant is being connected or disconnected, so one row's button spins and
  // the rest stay clickable — the same shape `probing` has, and for the same reason.
  const connecting = ref<string | null>(null)
  const loading = ref(false)
  // The backend's two definitive refusals: no `secrets.manage` (403), and — unlike the credential
  // store — never a 503, since the inventory needs no encryption key to project a registry. `null`
  // until first probed. A 403 HIDES the surface rather than disabling it, because the inventory
  // names the deployment's credential keys and its endpoints.
  const available = ref<boolean | null>(null)
  let inFlight: Promise<void> | null = null

  /**
   * Whether there is anything to show. A deployment that registers no tool server has no row to
   * render, and the panel section is hidden rather than rendering an empty heading.
   *
   * No `declarationsIncomplete` counterpart here, unlike the credential checklist: the inventory is
   * read straight off this process's own registry, so an empty answer is an answer rather than
   * possibly an outage.
   */
  const hasSurface = computed(() => (view.value?.servers.length ?? 0) > 0)

  /**
   * Refresh the inventory, sharing a read that is already in flight.
   *
   * Coalescing belongs on `load` and not only on `ensureLoaded` because both callers fire on the
   * same interaction: the Infrastructure window calls `ensureLoaded` to decide whether the tab
   * exists at all, and the panel refreshes on mount so a redeploy shows up without a reload. Two
   * identical GETs per open is what a plain "force" would have cost, and a read that started
   * microseconds ago IS the refresh.
   */
  async function load() {
    if (inFlight) return inFlight
    inFlight = readInventory().finally(() => (inFlight = null))
    return inFlight
  }

  async function readInventory() {
    const ws = useWorkspaceStore()
    loading.value = true
    try {
      view.value = await api.listToolServers(ws.requireId())
      available.value = true
    } catch (err) {
      if (apiErrorStatus(err) === 403) {
        // A definitive answer, not a failure: this caller may not manage secrets. Hide the surface
        // and stop probing; resolve normally.
        available.value = false
        view.value = null
        return
      }
      // Any other failure (transient 5xx / network) leaves the state untouched, so it neither hides
      // an available panel nor caches a false "unavailable", and PROPAGATES: the panel is the one
      // surface that can tell a reader it is looking at a list we could not fetch. Same split as the
      // capability-credential store.
      throw err
    } finally {
      loading.value = false
    }
  }

  /** Load once and stay loaded; `load()` re-reads (both share whatever is in flight). */
  async function ensureLoaded() {
    if (available.value !== null) return
    return load()
  }

  /**
   * Probe ONE server and keep its result.
   *
   * The result is stored for every outcome, failures included: a failure IS the answer the operator
   * asked for, and a store that only kept successes would leave the row looking untouched after the
   * probe reported a dead endpoint. A thrown error (a 404 for a server the deployment has since
   * dropped, a transient 5xx) propagates instead, because those are not probe verdicts.
   */
  async function probe(id: string) {
    const ws = useWorkspaceStore()
    probing.value = id
    try {
      const result = await api.probeToolServer(ws.requireId(), id)
      results.value = { ...results.value, [id]: result }
      return result
    } finally {
      probing.value = null
    }
  }

  /**
   * Start an OAuth grant and hand the browser to the vendor.
   *
   * A full-page navigation rather than a popup: the operator has to sign in at a third party, and a
   * popup is what a browser blocks and a password manager cannot fill. Nothing is stored here — the
   * vendor redirects back to `/mcp-oauth-callback`, which finishes the grant over the authenticated
   * API and returns here, so the connection state comes from the row rather than from anything this
   * store guessed across a navigation that leaves the app entirely.
   */
  async function connectOAuth(id: string) {
    const ws = useWorkspaceStore()
    connecting.value = id
    try {
      const { url } = await api.startToolServerOAuth(ws.requireId(), id)
      window.location.href = url
    } finally {
      connecting.value = null
    }
  }

  /**
   * Drop the workspace's grant, then re-read so the row's state comes from the backend rather than
   * from an optimistic edit: a disconnect is the one action whose whole point is that the server
   * stops being usable, and a row that looked connected for another second would be the misreport
   * this panel exists to prevent.
   */
  async function disconnectOAuth(id: string) {
    const ws = useWorkspaceStore()
    connecting.value = id
    try {
      await api.disconnectToolServerOAuth(ws.requireId(), id)
      // The stored probe result described a server this board could still reach. It cannot now.
      const { [id]: _dropped, ...rest } = results.value
      results.value = rest
    } finally {
      connecting.value = null
    }
    await load()
  }

  return {
    view,
    results,
    probing,
    connecting,
    loading,
    available,
    hasSurface,
    load,
    ensureLoaded,
    probe,
    connectOAuth,
    disconnectOAuth,
  }
})
