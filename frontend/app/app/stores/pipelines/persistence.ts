import type { Pipeline } from '~/types/domain'
import { useWorkspaceStore } from '~/stores/workspace'
import type { PipelinesContext } from './context'

/**
 * The pipeline persistence operations — building the draft payload and the create/update/clone/
 * remove/reseed/organize API calls. Extracted from the store setup into a factory closing over the
 * shared {@link PipelinesContext} plus the draft-lifecycle helpers it drives (`clearDraft` /
 * `loadForEdit`, owned by {@link createPipelineDraftActions}), so behaviour is byte-identical to the
 * former in-closure functions — the split is purely to keep the setup within the size budget.
 */
export function createPipelinePersistence(
  ctx: PipelinesContext,
  draft: { clearDraft: () => void; loadForEdit: (pipeline: Pipeline) => void },
) {
  const { api, upsertPipeline, dropPipeline, editingId } = ctx
  const { clearDraft, loadForEdit } = draft

  /** The optional arrays to send, omitting the ones that are at their defaults. */
  function draftPayload() {
    return {
      name: ctx.draftName.value.trim() || 'Untitled pipeline',
      // ALWAYS send description (like stepOptions) so an update can CLEAR it — an omitted field
      // reads as "keep existing", so toggling the last of the text away must send the empty string.
      // The backend trims + drops a blank one, so this is a no-op on create / an empty description.
      description: ctx.draftDescription.value.trim(),
      agentKinds: [...ctx.draft.value],
      // Only send gates when at least one step is gated.
      ...(ctx.draftGates.value.some(Boolean) ? { gates: [...ctx.draftGates.value] } : {}),
      // Only send enabled when at least one step is disabled (default is all-on).
      ...(ctx.draftEnabled.value.some((e) => e === false)
        ? { enabled: [...ctx.draftEnabled.value] }
        : {}),
      // Only send thresholds when at least one step pins an explicit value.
      ...(ctx.draftThresholds.value.some((t) => t != null)
        ? { thresholds: [...ctx.draftThresholds.value] }
        : {}),
      // Only send consensus when at least one step is consensus-enabled.
      ...(ctx.draftConsensus.value.some((c) => c?.enabled)
        ? { consensus: [...ctx.draftConsensus.value] }
        : {}),
      // Only send gating when at least one step has gating enabled.
      ...(ctx.draftGating.value.some((g) => g?.enabled)
        ? { gating: [...ctx.draftGating.value] }
        : {}),
      // Only send followUps when at least one step disables it (default is on, so only the
      // explicit `false` opt-outs are worth persisting).
      ...(ctx.draftFollowUps.value.some((f) => f === false)
        ? { followUps: [...ctx.draftFollowUps.value] }
        : {}),
      // Only send testerQuality when at least one Tester step deviates from the default
      // (companion disabled, or an estimate gate configured) — the default (null/enabled,
      // ungated) is not worth persisting.
      ...(ctx.draftTesterQuality.value.some((q) => q?.enabled === false || q?.gating?.enabled)
        ? { testerQuality: [...ctx.draftTesterQuality.value] }
        : {}),
      // ALWAYS send stepOptions, unlike the legacy per-step arrays above. Those omit-when-default,
      // which means an update can never CLEAR them (an omitted field reads as "keep existing"), so
      // toggling the last opt-out back to its default on a saved pipeline would silently not
      // persist. Sending the aligned array always lets `update` overwrite; the backend normalizes
      // an all-default array away (stores nothing), so this is a no-op on create / all-default.
      stepOptions: ctx.draftStepOptions.value.map((o) => o ?? null),
      // Only send labels when there are any.
      ...(ctx.draftLabels.value.length ? { labels: [...ctx.draftLabels.value] } : {}),
      // ALWAYS sent, like `stepOptions` above and for the same reason: `purpose` is mandatory on
      // create, and on update an omitted field reads as "keep existing", so a re-classification
      // would silently not persist. There is no "unclassified" to clear back to.
      purpose: ctx.draftPurpose.value,
    }
  }

  /** Persist the draft: update the pipeline being edited, else create a new one. */
  async function saveDraft(): Promise<Pipeline | null> {
    if (ctx.draft.value.length === 0) return null
    const wsId = useWorkspaceStore().requireId()
    const payload = draftPayload()
    if (editingId.value) {
      const updated = await api.updatePipeline(wsId, editingId.value, payload)
      upsertPipeline(updated)
      clearDraft()
      return updated
    }
    const pipeline = await api.createPipeline(wsId, payload)
    upsertPipeline(pipeline)
    clearDraft()
    return pipeline
  }

  /** Clone any pipeline (built-in or custom) into an editable copy, ready to edit. */
  async function clonePipeline(id: string): Promise<Pipeline> {
    const clone = await api.clonePipeline(useWorkspaceStore().requireId(), id)
    upsertPipeline(clone)
    loadForEdit(clone)
    return clone
  }

  async function removePipeline(id: string) {
    await api.removePipeline(useWorkspaceStore().requireId(), id)
    dropPipeline(id)
    if (editingId.value === id) clearDraft()
  }

  /**
   * Reseed a built-in pipeline from the backend's current catalog definition: restores its
   * canonical structure + version (adopting an update, or repairing a drifted/invalid copy)
   * while preserving its labels/archive state. Replaces the pipeline in the cache.
   */
  async function reseed(id: string): Promise<Pipeline> {
    const updated = await api.reseedPipeline(useWorkspaceStore().requireId(), id)
    upsertPipeline(updated)
    if (editingId.value === id) clearDraft()
    return updated
  }

  /**
   * Set a pipeline's organizational metadata (labels / archive / the two default claims). Works on
   * built-ins too, which is the whole reason the default claims live on this call: the rungs a
   * workspace most wants as its defaults are built-in, and a built-in refuses a structural edit.
   *
   * Promoting one row DEMOTES another, and the response names only the winner. So the incumbent is
   * released LOCALLY before the winner is upserted: a targeted edit of the two rows that changed,
   * rather than a full re-read (which this store has no door for — it hydrates from the workspace
   * snapshot) and rather than upserting the winner alone, which would leave two rows claiming the
   * same default on screen until the next snapshot.
   */
  async function organize(
    id: string,
    body: {
      labels?: string[]
      archived?: boolean
      isDefault?: boolean
      isUnattendedDefault?: boolean
    },
  ) {
    const updated = await api.organizePipeline(useWorkspaceStore().requireId(), id, body)
    if (body.isDefault !== undefined) releaseOtherClaims(id, 'isDefault')
    if (body.isUnattendedDefault !== undefined) releaseOtherClaims(id, 'isUnattendedDefault')
    upsertPipeline(updated)
    return updated
  }

  /** Drop `field` from every row but `id`, mirroring what the store just did server-side. */
  function releaseOtherClaims(id: string, field: 'isDefault' | 'isUnattendedDefault') {
    ctx.pipelines.value = ctx.pipelines.value.map((pipeline) =>
      pipeline.id === id || pipeline[field] !== true ? pipeline : { ...pipeline, [field]: false },
    )
  }

  const archive = (id: string) => organize(id, { archived: true })
  const unarchive = (id: string) => organize(id, { archived: false })
  const setLabels = (id: string, labels: string[]) => organize(id, { labels })
  const setDefault = (id: string, scope: 'interactive' | 'unattended', claimed: boolean) =>
    organize(id, scope === 'unattended' ? { isUnattendedDefault: claimed } : { isDefault: claimed })

  return {
    saveDraft,
    clonePipeline,
    removePipeline,
    reseed,
    organize,
    archive,
    unarchive,
    setLabels,
    setDefault,
  }
}
