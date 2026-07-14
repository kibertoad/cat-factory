import { type ComputedRef, type Ref, computed, ref } from 'vue'
import { apiErrorEnvelope, apiErrorStatus } from '~/composables/api/errors'
import { useSingleFlightProbe } from '~/composables/useSingleFlightProbe'
import { useUpsertList } from '~/composables/useUpsertList'

/**
 * The source-integration lifecycle shared by the document-source and task-source stores:
 * the opt-in `available` gate, the per-source `connections` list, the `descriptorFor` /
 * `connectionFor` / `isConnected` lookups, and a `probe()` that resolves all of it (hiding
 * the UI when the integration is off). Both stores previously hand-rolled this, with
 * inconsistent error handling — one captured the probe failure, the other swallowed it.
 * Standardising here means every integration now records WHY a probe failed
 * (`probeError`: a 503 "turned off on this deployment" vs a 500 "the backend errored"), so
 * a settings panel can explain the empty state instead of a blanket "install it first".
 *
 * The store supplies only what differs: how to fetch its sources + connections, and the
 * connect/disconnect calls (which feed `upsertConnection` / `removeConnection`). Source-
 * specific extras (diagnostics, per-source enable toggles, plan/spawn) stay in the store.
 */
export function useSourceIntegration<
  Source extends string,
  Conn extends { source: Source },
  Desc extends { source: Source },
>(opts: {
  /** Fetch the configured sources + live connections; throws when the integration is off. */
  fetch: () => Promise<{ sources: Desc[]; connections: Conn[] }>
  /** Gate the probe (e.g. skip until a workspace is selected). */
  enabled?: () => boolean
  /**
   * The active workspace id, keying the single-flight probe (app-startup initiative, item 12): a
   * board-open fan-out via `ensureProbed` hits the source once per board, and a workspace switch
   * (new id) re-probes. Omitted ⇒ a single bucket (probe-once for the composable's lifetime).
   */
  workspaceId?: () => string | null
}): {
  available: Ref<boolean | null>
  probeError: Ref<{ status: number | null; message: string } | null>
  sources: Ref<Desc[]>
  connections: Ref<Conn[]>
  connectedSources: ComputedRef<Desc[]>
  anyConnected: ComputedRef<boolean>
  descriptorFor: (source: Source) => Desc | undefined
  connectionFor: (source: Source) => Conn | undefined
  isConnected: (source: Source) => boolean
  upsertConnection: (conn: Conn) => void
  removeConnection: (source: Source) => void
  probe: () => Promise<void>
  ensureProbed: () => Promise<void>
} {
  /** null = unknown (not probed yet), true/false = integration on/off. */
  const available = ref<boolean | null>(null)
  /** Why the last probe failed, when it did (kept rather than swallowed). */
  const probeError = ref<{ status: number | null; message: string } | null>(null)
  const sources = ref<Desc[]>([]) as Ref<Desc[]>
  const { items: connections, upsert: upsertConnection } = useUpsertList<Conn>({
    key: (c) => c.source,
  })

  const connectedSources = computed(() =>
    sources.value.filter((s) => connections.value.some((c) => c.source === s.source)),
  )
  const anyConnected = computed(() => connections.value.length > 0)

  function descriptorFor(source: Source): Desc | undefined {
    return sources.value.find((s) => s.source === source)
  }
  function connectionFor(source: Source): Conn | undefined {
    return connections.value.find((c) => c.source === source)
  }
  function isConnected(source: Source): boolean {
    return connectionFor(source) !== undefined
  }
  function removeConnection(source: Source) {
    connections.value = connections.value.filter((c) => c.source !== source)
  }

  /** Probe the integration: resolves `available`, the sources and connections. */
  async function runProbe() {
    if (opts.enabled && !opts.enabled()) return
    try {
      const { sources: srcs, connections: conns } = await opts.fetch()
      available.value = true
      probeError.value = null
      sources.value = srcs
      connections.value = conns
    } catch (e) {
      // 503 (integration disabled) or any error → hide the UI entry points, but keep the
      // reason so a panel can explain it (503 = off here; 500 = the backend errored, e.g. an
      // unapplied migration).
      available.value = false
      const serverMessage = apiErrorEnvelope(e)?.message
      probeError.value = {
        status: apiErrorStatus(e) ?? null,
        message: serverMessage || (e instanceof Error ? e.message : String(e)),
      }
      sources.value = []
      connections.value = []
    }
  }
  // Single-flight the probe (app-startup initiative, item 12): `probe()` still re-reads on demand
  // (a connect/disconnect refresh), but the board-open fan-out uses `ensureProbed` so it fetches
  // once per board rather than on every SideBar/page (re)mount.
  const { probe, ensureProbed } = useSingleFlightProbe(
    runProbe,
    opts.workspaceId ?? (() => 'source-integration'),
  )

  return {
    available,
    probeError,
    sources,
    connections,
    connectedSources,
    anyConnected,
    descriptorFor,
    connectionFor,
    isConnected,
    upsertConnection,
    removeConnection,
    probe,
    ensureProbed,
  }
}
