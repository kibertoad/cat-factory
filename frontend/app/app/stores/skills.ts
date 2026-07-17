import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { SkillSummary } from '~/types/domain'

/**
 * The account's repo-sourced Claude Skills catalog (docs/initiatives/repo-skills.md slice 3),
 * hydrated from the workspace snapshot as lightweight `{ id, name, description }` summaries.
 * Drives the pipeline builder's per-step skill picker: a `skill` step binds its
 * `stepOptions.skillId` to one of these. Skills live in ONE tier (the account, shared across its
 * workspaces), so a snapshot hydrate is a straight replace — no per-board reset needed. The
 * account-settings management surface owns the full catalog + sources; it pushes its updated
 * summaries back here after a sync so the picker stays in step without a board reload.
 */
export const useSkillsStore = defineStore('skills', () => {
  const catalog = ref<SkillSummary[]>([])

  function hydrate(list: SkillSummary[]) {
    catalog.value = list
  }

  /** Resolve a skill summary by id (for rendering a picked skill's name in the builder). */
  function byId(id: string): SkillSummary | undefined {
    return catalog.value.find((s) => s.id === id)
  }

  return { catalog, hydrate, byId }
})
