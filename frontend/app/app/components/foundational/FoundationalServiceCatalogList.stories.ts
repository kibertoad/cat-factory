import type { Meta, StoryObj } from '@storybook/vue3'
import { getFoundationalServiceContractsContract } from '@cat-factory/contracts'
import { screen, userEvent } from 'storybook/test'
import { apiResponse } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { filesApiDocument, resolvedCatalog } from '~/stories/foundational.stories.mocks'
import { seedFoundationalCatalog, withSeed } from '~/stories/withStores'
import FoundationalServiceCatalogList from './FoundationalServiceCatalogList.vue'

// The catalog an architect on this board is handed: the deployment's services, the account's and
// the board's own, each with the tier that won, its capabilities and its contract manifest. An
// inherited service can be hidden from the board; the board's own is managed on the next tab. A
// service's contract documents load only when someone opens them, through the same read a step
// makes. The stories seed the catalog the board's manager would load.
const meta = {
  title: 'Settings/Components/FoundationalServiceCatalogList',
  component: FoundationalServiceCatalogList,
  decorators: [withSeed(() => seedFoundationalCatalog({ resolved: resolvedCatalog }))],
  parameters: { width: 'prose' },
} satisfies Meta<typeof FoundationalServiceCatalogList>
export default meta

type Story = StoryObj<typeof meta>

/**
 * Four services: the deployment's audit log, the account's file storage and notifications, and
 * the board's feature flags, which has no hide button.
 */
export const Default: Story = {}

/** Nothing registered at any tier. */
export const Empty: Story = {
  decorators: [withSeed(() => seedFoundationalCatalog({ resolved: [] }))],
}

/** Show contract documents on file storage: the Files API document, as a step would receive it. */
export const DocumentsOpen: Story = {
  parameters: {
    api: [
      apiResponse(getFoundationalServiceContractsContract, {
        pathPrefix: storyWorkspacePrefix,
        pathParams: { serviceId: 'file-storage' },
        body: [filesApiDocument],
      }),
    ],
  },
  play: async () => {
    const [fileStorage] = await screen.findAllByRole('button', { name: 'Show contract documents' })
    await userEvent.click(fileStorage!)
    await screen.findByText(/openapi: 3\.1\.0/)
  },
}
