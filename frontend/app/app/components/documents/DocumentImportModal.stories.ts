import type { Meta, StoryObj } from '@storybook/vue3'
import type { DocumentConnection, DocumentSourceKind, SourceDocument } from '@cat-factory/contracts'
import { listDocumentsContract } from '@cat-factory/contracts'
import { apiResponse } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import {
  documentConnections,
  documentSources,
  sourceDocuments,
} from '~/stories/integrations.stories.mocks'
import { seedDocumentSources, seedWorkspace, withSeed } from '~/stories/withStores'
import { useUiStore } from '~/stores/ui'
import DocumentImportModal from './DocumentImportModal.vue'

// Import a page from a connected document source by its URL or id, and see the pages already
// imported from that source, each with its sync state and a way to preview what it would add to
// the board. With more than one source connected a selector picks the source; with none, the
// modal offers to connect each one. It loads the imported documents when it opens, so each story
// answers that read. An import, a refresh and a preview send requests no story answers.
const meta = {
  title: 'Documents/Components/DocumentImportModal',
  component: DocumentImportModal,
  decorators: [opened(documentConnections.filter((c) => c.source === 'confluence'))],
  parameters: { api: [documentsAre(sourceDocuments)] },
} satisfies Meta<typeof DocumentImportModal>
export default meta

type Story = StoryObj<typeof meta>

function documentsAre(body: SourceDocument[]) {
  return apiResponse(listDocumentsContract, { pathPrefix: storyWorkspacePrefix, body })
}

/** The modal opened with `connections`, on `source` or else the first connected source. */
function opened(connections: DocumentConnection[], source: DocumentSourceKind | null = null) {
  return withSeed(() => {
    seedWorkspace()
    seedDocumentSources(documentSources, connections)
    useUiStore().openDocumentImport(source)
  })
}

/**
 * Only Confluence is connected, so there is no source selector: its page field, and the two
 * Confluence pages already imported.
 */
export const Default: Story = {}

/** Confluence is connected and nothing is imported from it yet. */
export const Empty: Story = { parameters: { api: [documentsAre([])] } }

/** No source is connected: one connect button per source the deployment offers. */
export const NotConnected: Story = { decorators: [opened([])] }

/**
 * Three sources connected, and the modal opened on Figma: the selector, the Figma field, and the
 * imported frame, whose images were only partly rendered.
 */
export const MultipleSources: Story = { decorators: [opened(documentConnections, 'figma')] }
