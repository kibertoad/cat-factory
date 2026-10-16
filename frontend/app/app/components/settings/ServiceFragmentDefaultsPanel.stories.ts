import type { Meta, StoryObj } from '@storybook/vue3'
import { resolvedFragmentsContract } from '@cat-factory/contracts'
import { screen, userEvent } from 'storybook/test'
import { apiResponse } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { fragmentCatalog } from '~/stories/fragments.stories.mocks'
import { seedWorkspace, withSeed } from '~/stories/withStores'
import { useServiceFragmentDefaultsStore } from '~/stores/serviceFragmentDefaults'
import ServiceFragmentDefaultsPanel from './ServiceFragmentDefaultsPanel.vue'

// The best-practice fragments every new service on the board starts with: one chip per fragment
// (a click removes it), a menu that adds one from the board's catalog by category, and links to
// where the fragments themselves are edited. A service already on the board keeps its own set.
// The panel loads the board's fragment catalog when it opens, so each story answers that read;
// the chosen ids are seeded as the snapshot carries them.
const defaultsAre = (ids: string[]) =>
  withSeed(() => {
    seedWorkspace()
    useServiceFragmentDefaultsStore().hydrate(ids)
  })

const meta = {
  title: 'Settings/Components/ServiceFragmentDefaultsPanel',
  component: ServiceFragmentDefaultsPanel,
  decorators: [defaultsAre(['node.performance', 'node.best-practices'])],
  parameters: {
    width: 'prose',
    api: [
      apiResponse(resolvedFragmentsContract, {
        pathPrefix: storyWorkspacePrefix,
        body: fragmentCatalog,
      }),
    ],
  },
} satisfies Meta<typeof ServiceFragmentDefaultsPanel>
export default meta

type Story = StoryObj<typeof meta>

/** Two Node fragments chosen. */
export const Default: Story = {}

/** None chosen: new services start with no fragments. */
export const Empty: Story = { decorators: [defaultsAre([])] }

/**
 * A chosen fragment the catalog no longer has (the account withdrew it): its chip shows the raw
 * id, so it can still be removed.
 */
export const UnknownFragment: Story = {
  decorators: [defaultsAre(['node.performance', 'acme.legacy-logging'])],
}

/** The add menu open: the catalog's other fragments, by category. */
export const AddMenuOpen: Story = {
  play: async () => {
    await userEvent.click(await screen.findByRole('button', { name: 'Add fragment' }))
  },
}
