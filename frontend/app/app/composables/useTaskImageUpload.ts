/**
 * Upload the images staged on a task that was just created. The task already exists, so a failed
 * upload must not undo it: it is reported through the error funnel and the remaining images stop,
 * which leaves the inspector's image section as the place to retry.
 */
export function useTaskImageUpload() {
  const api = useApi()
  const ws = useWorkspaceStore()
  const { present } = usePipelineErrorToast()

  async function uploadStaged(blockId: string, files: readonly File[]): Promise<void> {
    try {
      for (const file of files) await api.uploadTaskImage(ws.requireId(), blockId, file)
    } catch (e) {
      present(e, 'tasks.images.uploadFailed')
    }
  }

  return { uploadStaged }
}
