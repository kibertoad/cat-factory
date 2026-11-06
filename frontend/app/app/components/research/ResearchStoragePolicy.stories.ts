import type { Meta, StoryObj } from '@storybook/vue3'
import { researchPolicy } from '~/stories/research.stories.mocks'
import { seedWorkspace, withSeed } from '~/stories/withStores'
import ResearchStoragePolicy from './ResearchStoragePolicy.vue'

// The findings-storage tiers a board reads for a research project: the organization's, the
// board's and the project's, each set or inherited, and the policy they resolve to. Saving sends
// a request no story answers.
const meta = {
  title: 'Board/Components/ResearchStoragePolicy',
  component: ResearchStoragePolicy,
  parameters: { width: 'panel' },
  decorators: [withSeed(() => seedWorkspace())],
  args: { projectId: 'prj_vendor', view: researchPolicy },
} satisfies Meta<typeof ResearchStoragePolicy>
export default meta

type Story = StoryObj<typeof meta>

/** The organization sets the inline limit and the project turns offload on. */
export const Default: Story = {}

/** Nothing set at any tier: the platform defaults apply. */
export const AllInherited: Story = {
  args: {
    view: {
      account: null,
      workspace: null,
      project: null,
      effective: { inlineMaxBytes: 262_144, offload: 'enabled' },
    },
  },
}
