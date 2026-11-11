import type { Meta, StoryObj } from '@storybook/vue3'
import { outcomePolicy } from '~/stories/research.stories.mocks'
import { seedWorkspace, withSeed } from '~/stories/withStores'
import ProjectStoragePolicy from './ProjectStoragePolicy.vue'

// The outcome-storage tiers a board reads for a project: the organization's, the
// board's and the project's, each set or inherited, and the policy they resolve to. Saving sends
// a request no story answers.
const meta = {
  title: 'Board/Components/ProjectStoragePolicy',
  component: ProjectStoragePolicy,
  parameters: { width: 'panel' },
  decorators: [withSeed(() => seedWorkspace())],
  args: { projectId: 'prj_vendor', view: outcomePolicy },
} satisfies Meta<typeof ProjectStoragePolicy>
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
