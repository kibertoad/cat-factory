import { listPackageRegistriesContract } from '@cat-factory/contracts'
import type { PackageRegistryEntryView } from '@cat-factory/contracts'
import type { Meta, StoryObj } from '@storybook/vue3'
import { apiFailure, apiResponse } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { packageRegistryEntries } from '~/stories/infra.stories.mocks'
import { seedWorkspace, withSeed } from '~/stories/withStores'
import PackageRegistriesPanel from './PackageRegistriesPanel.vue'

// The private npm registries agent containers install from: the stored entries (vendor, scopes
// and the last characters of the token) above the form that adds one. A token is write-only, so
// an entry changes by removing it and adding it again. The panel loads the list on mount, so
// each story answers that request. The entries are shared with the Infrastructure window.
const entriesAre = (entries: PackageRegistryEntryView[]) =>
  apiResponse(listPackageRegistriesContract, {
    pathPrefix: storyWorkspacePrefix,
    body: { entries },
  })

const meta = {
  title: 'Settings/Components/PackageRegistriesPanel',
  component: PackageRegistriesPanel,
  parameters: {
    width: 'prose',
    api: [entriesAre(packageRegistryEntries)],
  },
  decorators: [withSeed(seedWorkspace)],
} satisfies Meta<typeof PackageRegistriesPanel>
export default meta

type Story = StoryObj<typeof meta>

/** An npmjs entry and a GitHub Packages entry with two scopes, above the add form. */
export const Default: Story = {}

/** No entries: the add form alone. */
export const Empty: Story = { parameters: { api: [entriesAre([])] } }

/** The list request failed: the failure toast, and the add form alone. */
export const Error: Story = {
  parameters: {
    api: [apiFailure(listPackageRegistriesContract, { pathPrefix: storyWorkspacePrefix })],
  },
}
