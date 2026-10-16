import type { Meta, StoryObj } from '@storybook/vue3'
import type {
  DocumentConnection,
  DocumentSourceDescriptor,
  SourceDocument,
} from '@cat-factory/contracts'
import { listDocumentsContract } from '@cat-factory/contracts'
import { screen, userEvent, within } from 'storybook/test'
import { apiResponse } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { authInitiative, boardWithInitiative, loginTask } from '~/stories/board.stories.mocks'
import {
  confluenceDescriptor,
  documentConnections,
  documentSources,
  figmaDescriptor,
  sourceDocument,
  sourceDocuments,
} from '~/stories/integrations.stories.mocks'
import { seedBoard, seedDocumentSources, seedWorkspace, withSeed } from '~/stories/withStores'
import TaskContextDocs from './TaskContextDocs.vue'
import { openSection, opensTo } from '~/stories/inspectorSection'

// The documents attached to a task or an initiative as agent context, each a link to its source
// page with its sync state. Attach opens the same inline picker as the add-task form; a pick is
// imported if needed and linked at once. With no source connected, the section offers to connect
// one instead. The source probe is seeded on the documents store, and the imported documents are
// answered for the section's load and the picker's. The section starts closed, so each story
// opens it. A pick, a connect and a refresh send requests no story answers.

/** The Confluence spec and the Figma frame, attached to the login task. */
const linkedToLogin: SourceDocument[] = sourceDocuments.map((d) =>
  d.externalId === '48213377' || d.source === 'figma' ? { ...d, linkedBlockId: loginTask.id } : d,
)

const meta = {
  title: 'Inspector/Components/TaskContextDocs',
  component: TaskContextDocs,
  args: { block: loginTask },
  decorators: [withSources(documentSources, documentConnections)],
  parameters: { width: 'panel', api: [documentsAre(linkedToLogin)] },
} satisfies Meta<typeof TaskContextDocs>
export default meta

type Story = StoryObj<typeof meta>

function documentsAre(body: SourceDocument[]) {
  return apiResponse(listDocumentsContract, { pathPrefix: storyWorkspacePrefix, body })
}

/** The sources the deployment offers and the ones the workspace connected, as the probe reads them. */
function withSources(sources: DocumentSourceDescriptor[], connections: DocumentConnection[]) {
  return withSeed(() => {
    seedWorkspace()
    seedBoard(boardWithInitiative)
    seedDocumentSources(sources, connections)
  })
}

/** Two documents, each with its source icon and when it was last synced. */
export const Default: Story = { play: opensTo((c) => c.findByText('Session lifecycle')) }

/** Nothing attached: the empty state says what to attach. */
export const Empty: Story = {
  parameters: { api: [documentsAre(sourceDocuments)] },
  play: opensTo((c) =>
    c.findByText('Attach a requirement, RFC or PRD so agents see it while implementing this task.'),
  ),
}

/** On an initiative the hint and the empty state name the planning agents instead. */
export const Initiative: Story = {
  args: { block: authInitiative },
  parameters: {
    api: [
      documentsAre([
        sourceDocument({
          externalId: '48990012',
          title: 'Identity platform RFC',
          url: 'https://acme.atlassian.net/wiki/spaces/ARCH/pages/48990012',
          linkedBlockId: authInitiative.id,
          docKind: 'rfc',
        }),
      ]),
    ],
  },
  play: opensTo((c) =>
    c.findByText(
      'Documents attached to this initiative as context. Their content is given to the planning agents that shape it.',
    ),
  ),
}

/**
 * Attach clicked: the picker opens on the first connected source, Confluence, and lists its
 * imported pages that are not attached yet.
 */
export const PickerOpen: Story = {
  play: async ({ canvasElement }) => {
    await openSection(canvasElement)
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Attach' }))
    await within(canvasElement).findByText('Service PRD template')
  },
}

/**
 * No source connected and no GitHub App, and the deployment offers only Confluence: one button
 * that names it.
 */
export const ConnectOneSource: Story = {
  decorators: [withSources([confluenceDescriptor], [])],
  parameters: { api: [documentsAre([])] },
  play: opensTo((c) => c.findByRole('button', { name: 'Connect Confluence' })),
}

/** No source connected, and two on offer: a menu. */
export const ConnectManySources: Story = {
  decorators: [withSources([confluenceDescriptor, figmaDescriptor], [])],
  parameters: { api: [documentsAre([])] },
  play: async ({ canvasElement }) => {
    await openSection(canvasElement)
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Connect a source' }))
    // The menu is teleported to `body`.
    await screen.findByRole('menuitem', { name: 'Figma' })
  },
}
