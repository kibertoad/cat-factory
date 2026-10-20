import type { Meta, StoryObj } from '@storybook/vue3'
import type { DocumentConnection, DocumentSourceKind } from '@cat-factory/contracts'
import { documentConnections, documentSources } from '~/stories/integrations.stories.mocks'
import { seedDocumentSources, seedWorkspace, withSeed } from '~/stories/withStores'
import { useUiStore } from '~/stores/ui'
import DocumentSourceConnectModal from './DocumentSourceConnectModal.vue'

// Connect the workspace to one document source, with the credential fields its descriptor
// declares. The backend never returns a stored secret, so a connected source shows empty fields,
// Update and Disconnect. A source that declares OAuth, on a deployment that registered an app for
// it, leads with a connect button and keeps the fields as the fallback. The descriptors are copies
// of the backend's (`integrations.stories.mocks.ts`). Connect, OAuth and disconnect send requests
// no story answers.
const meta = {
  title: 'Documents/Components/DocumentSourceConnectModal',
  component: DocumentSourceConnectModal,
  decorators: [opened('confluence', [])],
} satisfies Meta<typeof DocumentSourceConnectModal>
export default meta

type Story = StoryObj<typeof meta>

function opened(
  source: DocumentSourceKind,
  connections: DocumentConnection[],
  oauthSources: DocumentSourceKind[] = [],
) {
  return withSeed(() => {
    seedWorkspace()
    seedDocumentSources(documentSources, connections, oauthSources)
    useUiStore().openDocumentConnect(source)
  })
}

/** Confluence, not connected: the site, the email and the token, and Connect waits for all three. */
export const Default: Story = {}

/** Confluence, connected: the fields are empty because secrets are write-only, with Update and Disconnect. */
export const Connected: Story = { decorators: [opened('confluence', documentConnections)] }

/**
 * Figma, on a deployment with a registered Figma app: Connect with Figma first, the scopes it
 * asks for, and the token field below as the fallback.
 */
export const WithOAuth: Story = { decorators: [opened('figma', [], ['figma'])] }

/** Figma with no registered app: no OAuth button, only the token field and its long help. */
export const WithoutOAuth: Story = { decorators: [opened('figma', [])] }
