import type { RunDefaultScope } from '@cat-factory/contracts'
import type { Pipeline } from '~/types/domain'
import { usePipelinesStore } from '~/stores/pipelines'
import { usePipelineErrorToast } from '~/composables/usePipelineErrorToast'

/**
 * The actions a row of the saved-pipeline LIBRARY offers: archive, promote to a scope default,
 * edit, clone, delete.
 *
 * Extracted from `PipelineBuilder.vue` so that component stays inside its (shrink-only) size
 * budget. A cohesive seam rather than an arbitrary cut: every one of these takes a library row and
 * nothing else, none of them touches the DRAFT chain the rest of the builder is about, and each
 * reports its own failure — which is what makes them the same kind of thing.
 */
export function usePipelineLibraryActions() {
  const pipelines = usePipelinesStore()
  const toast = useToast()
  const { t } = useI18n()
  const { present } = usePipelineErrorToast()
  const { confirm } = useConfirm()

  /** Archive / unarchive: organize the library without deleting. Works on built-ins too. */
  async function toggleArchive(p: Pipeline) {
    try {
      if (p.archived) await pipelines.unarchive(p.id)
      else await pipelines.archive(p.id)
    } catch {
      toast.add({ title: t('pipeline.builder.toast.updateFailed'), color: 'error' })
    }
  }

  /**
   * Claim (or release) a pipeline as the workspace's default for one resolution scope.
   *
   * Both scopes are ADVANCED-tier controls in the builder, and the reason is the interface-mode rule
   * rather than the feeling of the setting: a workspace that names neither runs exactly what it runs
   * today (the interface-mode rung in the app, the seeded unattended rung headlessly), so hiding the
   * control leaves the same default a basic-tier user would have had. What is NOT hidden is the
   * resulting badge — a default somebody set has to be visible in the library at both tiers, or the
   * hidden control becomes a hidden decision.
   */
  async function toggleDefault(p: Pipeline, scope: RunDefaultScope) {
    const held = scope === 'unattended' ? p.isUnattendedDefault : p.isDefault
    try {
      await pipelines.setDefault(p.id, scope, !held)
    } catch (error) {
      present(error, 'pipeline.builder.toast.updateFailed')
    }
  }

  /** Load a custom pipeline into the draft for in-place editing. */
  function edit(p: Pipeline) {
    pipelines.loadForEdit(p)
  }

  async function removePipeline(p: Pipeline) {
    const ok = await confirm({
      title: t('pipeline.builder.confirmDeletePipeline.title'),
      description: t('pipeline.builder.confirmDeletePipeline.body', { name: p.name }),
      variant: 'destructive',
      confirmLabel: t('common.delete'),
      icon: 'i-lucide-trash-2',
    })
    if (ok) void pipelines.removePipeline(p.id)
  }

  /** Clone any pipeline (incl. a read-only built-in) into an editable copy. */
  async function clone(p: Pipeline) {
    try {
      const copy = await pipelines.clonePipeline(p.id)
      toast.add({
        title: t('pipeline.builder.toast.cloned', { name: p.name, copy: copy.name }),
        color: 'success',
        icon: 'i-lucide-copy',
      })
    } catch {
      toast.add({ title: t('pipeline.builder.toast.cloneFailed'), color: 'error' })
    }
  }

  return { toggleArchive, toggleDefault, edit, removePipeline, clone }
}
