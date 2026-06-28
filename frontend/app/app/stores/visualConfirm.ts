import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useExecutionStore } from '~/stores/execution'
import { useWorkspaceStore } from '~/stores/workspace'

/**
 * Visual-confirmation gate actions. The gate's live state rides on its execution step
 * (`step.visualConfirm`) and arrives via the execution stream, so this store holds NO gate
 * state — it only drives the actions (approve / request a fix / recapture) and uploads
 * reference design images. A per-block `busy` flag lets the window disable its controls
 * while an action is in flight. (Resolving stored artifacts into object URLs for the gallery
 * lives in the per-component `useArtifactBlobs` composable, so each window owns + revokes its
 * own blob cache on unmount.)
 */
export const useVisualConfirmStore = defineStore('visualConfirm', () => {
  const api = useApi()
  const ws = useWorkspaceStore()
  const execution = useExecutionStore()

  const busy = ref<Set<string>>(new Set())

  function isBusy(blockId: string): boolean {
    return busy.value.has(blockId)
  }

  async function run(blockId: string, action: () => Promise<unknown>): Promise<void> {
    const next = new Set(busy.value)
    next.add(blockId)
    busy.value = next
    try {
      const instance = await action()
      if (instance && typeof instance === 'object' && 'steps' in instance) {
        execution.upsert(instance as Parameters<typeof execution.upsert>[0])
      }
    } finally {
      const after = new Set(busy.value)
      after.delete(blockId)
      busy.value = after
    }
  }

  /** Approve the reviewed screenshots: advance the pipeline. */
  function approve(blockId: string): Promise<void> {
    return run(blockId, () => api.approveVisualConfirm(ws.requireId(), blockId))
  }

  /** Submit findings and request a fix. */
  function requestFix(blockId: string, findings: string): Promise<void> {
    return run(blockId, () => api.requestVisualConfirmFix(ws.requireId(), blockId, findings))
  }

  /** Refresh the actual-vs-reference pairs from the latest UI-tester report. */
  function recapture(blockId: string): Promise<void> {
    return run(blockId, () => api.recaptureVisualConfirm(ws.requireId(), blockId))
  }

  /** Upload a reference design image for a block, tagged with the view it depicts. */
  function uploadReference(blockId: string, file: File, view: string): Promise<void> {
    return run(blockId, () => api.uploadReferenceArtifact(ws.requireId(), blockId, file, view))
  }

  return { isBusy, approve, requestFix, recapture, uploadReference }
})
