import type { Meta, StoryObj } from '@storybook/vue3'
import { fragmentLibraryApi } from '~/stories/fragmentLibraryApi'
import { fragmentCatalog } from '~/stories/fragments.stories.mocks'
import { githubProbeApi } from '~/stories/githubApi'
import { documentProbeApi } from '~/stories/shellApi'
import { seedWorkspace, withSeed } from '~/stories/withStores'
import { useUiStore } from '~/stores/ui'
import FragmentLibraryPanel from './FragmentLibraryPanel.vue'

// The board's prompt-fragment library window: the best-practice standards agents follow, as the
// built-ins, the account's and the board's own merge, with tabs to author fragments, import them
// from documents and link repositories. It opens on the merged catalog. The library manager
// inside loads the board's library, the document sources and the GitHub connection when it opens,
// so the story answers those reads. The manager's own tabs are the L row `FragmentLibraryManager`.
const meta = {
  title: 'Settings/Components/FragmentLibraryPanel',
  component: FragmentLibraryPanel,
  decorators: [
    withSeed(() => {
      seedWorkspace()
      useUiStore().openFragmentLibrary()
    }),
  ],
  parameters: {
    api: [
      ...fragmentLibraryApi('workspace', { resolved: fragmentCatalog }),
      ...documentProbeApi(),
      ...githubProbeApi(),
    ],
  },
} satisfies Meta<typeof FragmentLibraryPanel>
export default meta

type Story = StoryObj<typeof meta>

/** The merged catalog: the built-in fragments, grouped by category. */
export const Default: Story = {}
