import { SKILL_GROUPS } from '@cat-factory/contracts'
import type { SkillGroup, SkillSummary } from '~/types/domain'

// ---------------------------------------------------------------------------
// Shared presentation and filtering for the account's Claude Skills catalog.
//
// A skill declares a GROUP in its `SKILL.md` frontmatter (what kind of work its playbook does),
// and the surfaces that offer skills each want a different slice of the catalog: the review
// task's queue offers the `review` group, the library manager lists everything grouped. Both the
// label lookup and the filter live here, once, rather than in each component.
//
// The label map is an exhaustive `Record<SkillGroup, string>`, so adding a member to the contracts
// vocabulary fails the typecheck here instead of rendering a raw id (or nothing) in a picker.
// ---------------------------------------------------------------------------

/** i18n catalog key per group. Prose, so keys rather than the constants VCS labels use. */
export const SKILL_GROUP_LABEL_KEYS: Record<SkillGroup, string> = {
  build: 'skills.groups.build',
  review: 'skills.groups.review',
  test: 'skills.groups.test',
  write: 'skills.groups.write',
  plan: 'skills.groups.plan',
  operate: 'skills.groups.operate',
  other: 'skills.groups.other',
}

/** Icon per group, so a picker row reads as its shelf at a glance. */
export const SKILL_GROUP_ICONS: Record<SkillGroup, string> = {
  build: 'i-lucide-hammer',
  review: 'i-lucide-clipboard-check',
  test: 'i-lucide-flask-conical',
  write: 'i-lucide-pen-line',
  plan: 'i-lucide-map',
  operate: 'i-lucide-server-cog',
  other: 'i-lucide-book-open-check',
}

/**
 * Display order for a grouped listing: the delivery loop first, `other` last. Derived FROM the
 * contracts vocabulary rather than restated, so a member added there appears (before `other`)
 * instead of silently vanishing from a listing that hard-coded the order.
 */
export const SKILL_GROUP_ORDER: readonly SkillGroup[] = [
  ...SKILL_GROUPS.filter((g) => g !== 'other'),
  'other',
]

/**
 * The catalog entries a surface offering `group` may show, in catalog order.
 *
 * Filtering on the group the BACKEND already normalized: a summary's group is narrowed to the
 * wire vocabulary before it reaches the snapshot, so nothing here re-derives a classification the
 * catalog owns, and a skill whose manifest declared an unknown group is offered under `other`
 * rather than being offered everywhere or nowhere.
 */
export function skillsInGroup(catalog: readonly SkillSummary[], group: SkillGroup): SkillSummary[] {
  return catalog.filter((skill) => skill.group === group)
}
