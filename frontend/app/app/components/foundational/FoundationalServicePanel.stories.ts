import type { Meta, StoryObj } from '@storybook/vue3'
import { foundationalApi } from '~/stories/foundationalApi'
import {
  resolvedCatalog,
  suppressions,
  workspaceServices,
} from '~/stories/foundational.stories.mocks'
import { githubProbeApi } from '~/stories/githubApi'
import { seedWorkspace, withSeed } from '~/stories/withStores'
import { useUiStore } from '~/stores/ui'
import FoundationalServicePanel from './FoundationalServicePanel.vue'

// The board's foundational-services window: the catalog an architect is handed, the board's own
// services, its linked repositories and its developer portal, on four tabs. It opens on the
// catalog. The manager inside loads the board's catalog and probes GitHub when it opens, so the
// story answers those reads; each section's own states are in its own stories.
const meta = {
  title: 'Settings/Components/FoundationalServicePanel',
  component: FoundationalServicePanel,
  decorators: [
    withSeed(() => {
      seedWorkspace()
      useUiStore().openFoundationalServices()
    }),
  ],
  parameters: {
    api: [
      ...foundationalApi('workspace', {
        services: workspaceServices,
        resolved: resolvedCatalog,
        suppressions,
      }),
      ...githubProbeApi(),
    ],
  },
} satisfies Meta<typeof FoundationalServicePanel>
export default meta

type Story = StoryObj<typeof meta>

/** The catalog tab: four services from three tiers, and the two the board hides. */
export const Default: Story = {}
