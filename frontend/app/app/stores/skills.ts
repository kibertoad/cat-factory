import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { SkillSummary } from '~/types/domain'
import { skillsInGroup } from '~/utils/skills'

/**
 * The account's repo-sourced Claude Skills catalog (ADR 0024 slice 3),
 * hydrated from the workspace snapshot as lightweight `{ id, name, description }` summaries.
 * Drives the pipeline builder's per-step skill picker (a `skill` step binds its
 * `stepOptions.skillId` to one of these) and the review task's skill queue, which offers the
 * `review` slice of the same catalog. Skills live in ONE tier (the account, shared across its
 * workspaces), so a snapshot hydrate is a straight replace — no per-board reset needed. The
 * account-settings management surface owns the full catalog + sources; it pushes its updated
 * summaries back here after a sync so the picker stays in step without a board reload.
 */
export const useSkillsStore = defineStore('skills', () => {
  const catalog = ref<SkillSummary[]>([])

  /**
   * The skills a REVIEW task may queue: the catalog's `review` group and nothing else. A skill is
   * offered by what its manifest says it does, so a build or release-notes playbook never reaches
   * a picker whose whole job is to add review lenses. Empty is the ordinary state (an account with
   * no review skills authored yet), not a fault, and the picker says so rather than hiding.
   */
  const reviewSkills = computed(() => skillsInGroup(catalog.value, 'review'))

  function hydrate(list: SkillSummary[]) {
    catalog.value = list
  }

  return { catalog, reviewSkills, hydrate }
})
