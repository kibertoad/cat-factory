import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type {
  ApiContractDocument,
  CreateFoundationalServiceInput,
  FoundationalService,
  FoundationalServiceOwnerKind,
  FoundationalServiceSource,
  FoundationalServiceSuppression,
  FoundationalServiceSyncResult,
  LinkFoundationalServiceSourceInput,
  ResolvedFoundationalService,
  UpdateFoundationalServiceInput,
} from '~/types/domain'
import { useSingleFlightProbe } from '~/composables/useSingleFlightProbe'
import { useWorkspaceStore } from '~/stores/workspace'

/**
 * The foundational-services catalog for one owner — a board (`workspace`) or an `account`
 * (backend/docs/adr/0031-foundational-services.md). Holds that owner's own (raw) tier of registered
 * services, its linked repo sources, and — at the **workspace** tier only — the merged catalog an
 * Architect actually sees (account ⊕ workspace, workspace winning).
 *
 * Three things about this store follow the feature's design rather than the fragment library's:
 *
 * - **Contract documents are never held here.** The catalog reads carry a contract MANIFEST
 *   (id, format, size, operation names) and no bodies, because that is the whole reason a design
 *   prompt scales with the number of an org's services rather than the size of its specs. A body
 *   is fetched on demand, per service, by {@link contractsFor}, and cached only for the session.
 * - **`suppress` / `restore` are workspace-only**, and they are not "delete". Suppression opts a
 *   board out of an INHERITED account service and destroys nothing; deleting removes the board's
 *   own registration and its uploaded documents.
 * - **`sourcesAvailable` is the finer gate**, exactly as in the skill library: the catalog works
 *   without the GitHub integration (contracts can be uploaded directly), while the repo-source
 *   routes 503 without it.
 */
function foundationalServicesSetup(
  kind: FoundationalServiceOwnerKind,
  resolveOwnerId: () => string | null,
) {
  const api = useApi()

  /**
   * The merged/resolved catalog only exists at the workspace tier — a board is what runs agents.
   * The SUPPRESSION pair is not gated on it: an account inherits the deployment's code-registered
   * `builtin` services exactly as a board inherits its account's, so both tiers can opt out.
   */
  const hasResolved = kind === 'workspace'

  /** null = not probed yet; true/false = the catalog is on/off for this deployment. */
  const available = ref<boolean | null>(null)
  /** false when the GitHub integration is off: the catalog works, repo sources do not. */
  const sourcesAvailable = ref(true)
  /** This owner's own registered services (its tier, raw). */
  const services = ref<FoundationalService[]>([])
  /** The merged catalog an Architect sees (workspace tier only; empty otherwise). */
  const resolved = ref<ResolvedFoundationalService[]>([])
  /**
   * What this board is opted OUT of (workspace tier only; empty otherwise). Its own read because
   * a suppressed id is by construction absent from {@link resolved} — without it, suppression
   * would be a one-way door.
   */
  const suppressions = ref<FoundationalServiceSuppression[]>([])
  /** Linked repo sources for this owner. */
  const sources = ref<FoundationalServiceSource[]>([])
  /** Per-source "changes available" flag from the last status check. */
  const sourceChanges = ref<Record<string, boolean>>({})
  /**
   * Session cache of fetched contract DOCUMENTS, keyed by service id. Populated only by an
   * explicit {@link contractsFor}, so opening the surface never transfers a document body — the
   * property the whole two-table split exists to guarantee.
   */
  const contractBodies = ref<Record<string, ApiContractDocument[]>>({})

  /** How many entries of the merged catalog this board inherits rather than owns. */
  const inheritedCount = computed(
    () => resolved.value.filter((entry) => entry.tier !== 'workspace').length,
  )

  function requireOwnerId(): string {
    const id = resolveOwnerId()
    if (!id) throw new Error('No foundational-services owner')
    return id
  }

  function requireWorkspaceId(): string {
    if (!hasResolved) throw new Error('Foundational-service inheritance is workspace-scoped')
    return requireOwnerId()
  }

  /** Probe the feature + load this owner's tier, sources and (ws) the merged catalog. */
  async function runProbe() {
    const id = resolveOwnerId()
    if (!id) return
    try {
      const [tier, merged, opted] = await Promise.all([
        api.listFoundationalServices(kind, id),
        hasResolved
          ? api.getResolvedFoundationalServices(id)
          : Promise.resolve([] as ResolvedFoundationalService[]),
        api.listFoundationalServiceSuppressions(kind, id),
      ])
      services.value = tier
      resolved.value = merged
      suppressions.value = opted
      available.value = true
    } catch {
      // Reset EVERY view, `sourcesAvailable` included. Leaving it at its previous value would
      // let a re-probe of an owner whose catalog is now unreachable keep claiming the repo-source
      // half is wired, which is the one flag here that gates an affordance rather than content.
      available.value = false
      services.value = []
      resolved.value = []
      suppressions.value = []
      sources.value = []
      sourceChanges.value = {}
      sourcesAvailable.value = false
      return
    }
    // Repo sources need the GitHub integration; a 503 here hides only the linking UI — the
    // catalog read above already succeeded, so the feature itself is on.
    try {
      sources.value = await api.listFoundationalSources(kind, id)
      sourcesAvailable.value = true
    } catch {
      sources.value = []
      sourcesAvailable.value = false
    }
  }
  // Single-flight the probe keyed on the owner id, so a panel-open fan-out loads once per owner.
  const { probe, ensureProbed } = useSingleFlightProbe(runProbe, () => resolveOwnerId())

  async function reloadTier() {
    services.value = await api.listFoundationalServices(kind, requireOwnerId())
  }

  async function refreshResolved() {
    const id = requireOwnerId()
    // Both in one pass: a write that changes the merge routinely changes the opt-out list too
    // (suppressing removes an entry from one and adds it to the other), and refreshing only the
    // catalog would leave the way BACK stale — the exact state the pair exists to avoid.
    const [merged, opted] = await Promise.all([
      hasResolved
        ? api.getResolvedFoundationalServices(id)
        : Promise.resolve([] as ResolvedFoundationalService[]),
      api.listFoundationalServiceSuppressions(kind, id),
    ])
    resolved.value = merged
    suppressions.value = opted
  }

  /** Every write invalidates both views: a tier edit changes what the merge resolves to. */
  async function reload() {
    await Promise.all([reloadTier(), refreshResolved()])
  }

  async function create(input: CreateFoundationalServiceInput) {
    await api.createFoundationalService(kind, requireOwnerId(), input)
    await reload()
  }

  async function update(serviceId: string, patch: UpdateFoundationalServiceInput) {
    await api.updateFoundationalService(kind, requireOwnerId(), serviceId, patch)
    // A contract replacement changes the stored bodies, so drop the cached copy rather than
    // letting a stale document be shown as what a consumer would receive.
    delete contractBodies.value[serviceId]
    await reload()
  }

  /** Remove this tier's OWN registration (and its uploaded documents). */
  async function remove(serviceId: string) {
    await api.deleteFoundationalService(kind, requireOwnerId(), serviceId)
    delete contractBodies.value[serviceId]
    await reload()
  }

  /** Opt this tier out of a service it INHERITS. Destroys nothing; reversible. */
  async function suppress(serviceId: string) {
    await api.suppressFoundationalService(kind, requireOwnerId(), serviceId)
    await reload()
  }

  /** Lift a suppression, so this tier inherits the service again. */
  async function restore(serviceId: string) {
    await api.restoreFoundationalService(kind, requireOwnerId(), serviceId)
    await reload()
  }

  /**
   * Fetch (and cache for the session) one service's full contract documents — the same lazy read
   * a consumer dispatch makes, so what a human inspects here is what an agent would be handed.
   */
  async function contractsFor(serviceId: string): Promise<ApiContractDocument[]> {
    const cached = contractBodies.value[serviceId]
    if (cached) return cached
    const documents = await api.getFoundationalServiceContracts(requireWorkspaceId(), serviceId)
    contractBodies.value = { ...contractBodies.value, [serviceId]: documents }
    return documents
  }

  async function reloadSources() {
    sources.value = await api.listFoundationalSources(kind, requireOwnerId())
  }

  async function linkSource(input: LinkFoundationalServiceSourceInput) {
    const source = await api.linkFoundationalSource(kind, requireOwnerId(), input)
    sources.value = [source, ...sources.value]
    // Sync immediately so the linked repo's services land in the catalog rather than waiting for
    // the autorefresh sweep — a freshly linked source that shows nothing reads as a broken link.
    await syncSource(source.id)
    return source
  }

  async function unlinkSource(sourceId: string) {
    await api.unlinkFoundationalSource(kind, requireOwnerId(), sourceId)
    sources.value = sources.value.filter((s) => s.id !== sourceId)
    delete sourceChanges.value[sourceId]
    await reload()
  }

  /** Resync a source's definitions into the catalog, then refresh both views. */
  async function syncSource(sourceId: string): Promise<FoundationalServiceSyncResult> {
    const result = await api.syncFoundationalSource(kind, requireOwnerId(), sourceId)
    delete sourceChanges.value[sourceId]
    await Promise.all([reloadSources(), reload()])
    return result
  }

  /** The cheap commit-version "check for changes" for a source; caches the flag. */
  async function checkSource(sourceId: string) {
    const status = await api.foundationalSourceStatus(kind, requireOwnerId(), sourceId)
    sourceChanges.value = { ...sourceChanges.value, [sourceId]: status.changed }
    return status
  }

  return {
    kind,
    hasResolved,
    available,
    sourcesAvailable,
    services,
    resolved,
    suppressions,
    sources,
    sourceChanges,
    contractBodies,
    inheritedCount,
    probe,
    ensureProbed,
    create,
    update,
    remove,
    suppress,
    restore,
    contractsFor,
    linkSource,
    unlinkSource,
    syncSource,
    checkSource,
  }
}

/**
 * The workspace-tier catalog for the **active** board — a singleton that resolves the owner
 * lazily, so it follows board switches and is shared by the navbar and the board modal.
 */
export const useFoundationalServicesStore = defineStore('foundationalServices', () =>
  foundationalServicesSetup('workspace', () => useWorkspaceStore().workspaceId),
)

/**
 * An owner-keyed catalog store, used for the **account** tier (and reusable for any explicit
 * owner). Keyed by `(kind, ownerId)` so each account gets isolated state.
 */
export function useFoundationalServices(kind: FoundationalServiceOwnerKind, ownerId: string) {
  return defineStore(`foundationalServices:${kind}:${ownerId}`, () =>
    foundationalServicesSetup(kind, () => ownerId),
  )()
}
