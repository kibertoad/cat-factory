import type { Meta, StoryObj } from '@storybook/vue3'
import type { PipelinePurpose } from '@cat-factory/contracts'
import { ref } from 'vue'
import { userEvent, within } from 'storybook/test'
import { withSeed } from '~/stories/withStores'
import { useAgentTierStore } from '~/stores/agentTier'
import { useReleaseHealthStore } from '~/stores/releaseHealth'
import AgentPalette from './AgentPalette.vue'

// The pipeline builder's agent catalog: pick what the pipeline is for and how deep into the
// catalog to look, then click an agent to add it as a step. The agents are grouped by category,
// and a category folds on a click. The release-health gate shows only with an observability
// integration connected. The render keeps the purpose, so a change in the menu narrows the list.
//
// Which categories are folded is kept in the browser's local storage, which outlives a story, so
// every story sets the folds first.
const COLLAPSED_KEY = 'cf.pipelineBuilder.collapsedAgentCategories'

function folded(categories: string[]) {
  return withSeed(() => {
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify(categories))
    } catch {
      // Storage refused (a private window): every category opens, which the story then shows.
    }
  })
}

const meta = {
  title: 'Pipeline/Components/AgentPalette',
  component: AgentPalette,
  args: { purpose: 'build' },
  parameters: { width: 'narrow' },
  decorators: [folded([])],
  render: (args) => ({
    components: { AgentPalette },
    setup() {
      const purpose = ref<PipelinePurpose>(args.purpose)
      return { purpose }
    },
    template: '<AgentPalette :purpose="purpose" @update:purpose="purpose = $event" />',
  }),
} satisfies Meta<typeof AgentPalette>
export default meta

type Story = StoryObj<typeof meta>

/** A build pipeline at the basic tier: the everyday agents, by category. */
export const Default: Story = {}

/** The advanced tier: the whole catalog for a build pipeline. */
export const AdvancedTier: Story = {
  decorators: [withSeed(() => useAgentTierStore().setTier('advanced'))],
}

/** A review pipeline: only the categories a review has any use for. */
export const ReviewPurpose: Story = { args: { purpose: 'review' } }

/**
 * Datadog connected, at the intermediate tier: the release-health gate joins the gates. The site
 * is made up.
 */
export const WithObservabilityGate: Story = {
  decorators: [
    withSeed(() => {
      useAgentTierStore().setTier('intermediate')
      useReleaseHealthStore().connection = {
        connected: true,
        provider: 'datadog',
        summary: { site: 'datadoghq.eu' },
      }
    }),
  ],
}

/** A click on Implementation folds it to its heading and count. */
export const CollapsedCategory: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: /Implementation/ }))
    await within(canvasElement).findByRole('button', { name: /Implementation/, expanded: false })
  },
}
