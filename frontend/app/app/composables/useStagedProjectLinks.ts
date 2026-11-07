import { ref } from 'vue'

/**
 * Projects staged on the create-task form, linked once the task exists. The task is already
 * created when the link runs, so a refused link (a project with no result yet) is reported and
 * the task kept, as staged documents are.
 */
export function useStagedProjectLinks() {
  const staged = ref<string[]>([])
  const projects = useProjectsStore()
  const { present } = usePipelineErrorToast()

  async function linkStaged(blockId: string): Promise<void> {
    if (staged.value.length === 0) return
    try {
      await projects.linkToTask(blockId, [...staged.value])
    } catch (e) {
      present(e, 'projects.taskLinks.linkFailed')
    }
  }

  return { staged, linkStaged }
}
