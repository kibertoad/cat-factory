import type { Meta, StoryObj } from '@storybook/vue3'
import type { CapabilityCredentialsView } from '@cat-factory/contracts'
import { getCapabilityCredentialsContract, listToolServersContract } from '@cat-factory/contracts'
import { apiResponse } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { declaredCapabilityCredentials } from '~/stories/infra.stories.mocks'
import { seedWorkspace, withSeed } from '~/stories/withStores'
import CapabilityCredentialsPanel from './CapabilityCredentialsPanel.vue'

// The values behind the secrets the deployment's tool servers, generative integrations and
// foundational services declare by name: one row per declared key, saying who wants it, whether a
// value is stored, and what an empty row means on this deployment. Values are write-only and saved
// one key at a time. Stored keys nothing declares any more are listed apart. The panel loads the
// credentials and the tool-server inventory when it mounts, so each story answers both; the
// inventory is empty here, so its section does not render (its own stories show it). The keys are
// shared with the Infrastructure window.
const pathPrefix = storyWorkspacePrefix

function viewIs(view: Partial<CapabilityCredentialsView>) {
  return [
    apiResponse(getCapabilityCredentialsContract, {
      pathPrefix,
      body: {
        declared: declaredCapabilityCredentials,
        orphaned: [],
        environmentFallback: false,
        declarationsIncomplete: false,
        ...view,
      },
    }),
    apiResponse(listToolServersContract, { pathPrefix, body: { servers: [] } }),
  ]
}

const meta = {
  title: 'Settings/Components/CapabilityCredentialsPanel',
  component: CapabilityCredentialsPanel,
  decorators: [withSeed(seedWorkspace)],
  parameters: { width: 'prose', api: viewIs({}) },
} satisfies Meta<typeof CapabilityCredentialsPanel>
export default meta

type Story = StoryObj<typeof meta>

/**
 * Three keys: one stored and wanted by two capabilities, one required and missing, which the
 * row warns about because nothing else can answer it, and one optional.
 */
export const Default: Story = {}

/** No capability declares a credential. */
export const Empty: Story = { parameters: { api: viewIs({ declared: [] }) } }

/** The declarations could not all be read: a warning that the list may be short. */
export const DeclarationsIncomplete: Story = {
  parameters: { api: viewIs({ declarationsIncomplete: true }) },
}

/** The deployment's own environment may still answer a missing key: the empty rows say so. */
export const EnvironmentFallback: Story = {
  parameters: { api: viewIs({ environmentFallback: true }) },
}

/** A stored key nothing declares any more, listed apart with Remove. */
export const Orphaned: Story = {
  parameters: {
    api: viewIs({ orphaned: [{ key: 'OLD_SEARCH_KEY', updatedAt: Date.UTC(2026, 6, 20) }] }),
  },
}
