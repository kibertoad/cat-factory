import type { Meta, StoryObj } from '@storybook/vue3'
import type { SkillSummary } from '@cat-factory/contracts'
import { MAX_REVIEW_SKILLS } from '@cat-factory/contracts'
import { ref } from 'vue'
import { userEvent, within } from 'storybook/test'
import { skillCatalog as catalog } from '~/stories/skills.stories.mocks'
import { withSeed } from '~/stories/withStores'
import { useSkillsStore } from '~/stores/skills'
import ReviewSkillQueue from './ReviewSkillQueue.vue'

// The ordered queue of review playbooks a review task runs, as numbered badges: the reviewer
// applies them in that order. The add button opens a picker that offers only the catalog's
// `review` group. The queue is a `v-model`, so the stories keep it in a local ref and a click on
// a badge or a picker row changes it. The catalog is the shared one in `skills.stories.mocks.ts`.

const withCatalog = (skills: SkillSummary[]) => withSeed(() => useSkillsStore().hydrate(skills))

const meta = {
  title: 'Board/Components/ReviewSkillQueue',
  component: ReviewSkillQueue,
  parameters: { width: 'panel' },
  args: { modelValue: ['skill_security', 'skill_perf'] },
  decorators: [withCatalog(catalog)],
  render: (args) => ({
    components: { ReviewSkillQueue },
    setup: () => ({ queue: ref([...args.modelValue]) }),
    template: '<ReviewSkillQueue v-model="queue" />',
  }),
} satisfies Meta<typeof ReviewSkillQueue>
export default meta

type Story = StoryObj<typeof meta>

const openPicker: Story['play'] = async ({ canvasElement }) => {
  await userEvent.click(within(canvasElement).getByTestId('review-skill-add'))
}

/** Room below the field for the picker, which opens downward out of the frame otherwise. */
const withPickerRoom: Story['render'] = (args) => ({
  components: { ReviewSkillQueue },
  setup: () => ({ queue: ref([...args.modelValue]) }),
  template: '<div class="pb-96"><ReviewSkillQueue v-model="queue" /></div>',
})

/** Two skills queued: security first, then performance. */
export const Default: Story = {}

/** Nothing queued: the hint about what the queue is for. */
export const Empty: Story = { args: { modelValue: [] } }

/** The picker: the four review skills, the two queued ones ticked. The build skill is left out. */
export const PickerOpen: Story = { render: withPickerRoom, play: openPicker }

/** A catalog with no review skills: the picker says how to offer one. */
export const NoReviewSkills: Story = {
  args: { modelValue: [] },
  decorators: [withCatalog(catalog.filter((s) => s.group !== 'review'))],
  render: withPickerRoom,
  play: openPicker,
}

/**
 * The queue at its cap: a note under the list gives the limit. The one row not queued is
 * disabled, below the fold of the picker's scroll.
 */
export const AtCap: Story = {
  args: {
    modelValue: [
      ...catalog.filter((s) => s.group === 'review').map((s) => s.id),
      ...Array.from({ length: MAX_REVIEW_SKILLS - 4 }, (_, i) => `skill_team_${i + 1}`),
    ],
  },
  decorators: [
    withCatalog([
      ...catalog,
      ...Array.from({ length: MAX_REVIEW_SKILLS - 3 }, (_, i) => ({
        id: `skill_team_${i + 1}`,
        name: `Team check ${i + 1}`,
        description: 'A team-authored review lens.',
        group: 'review' as const,
      })),
    ]),
  ],
  render: withPickerRoom,
  play: openPicker,
}

/**
 * A queued id the catalog no longer has: the badge shows the raw id, and that is the entry the
 * next dispatch fails on.
 */
export const UnknownSkill: Story = {
  args: { modelValue: ['skill_security', 'skill_legacy_style'] },
}
