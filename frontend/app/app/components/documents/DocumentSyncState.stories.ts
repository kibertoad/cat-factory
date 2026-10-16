import type { Meta, StoryObj } from '@storybook/vue3'
import type { DocumentFreshness, SourceDocument } from '@cat-factory/contracts'
import { refreshDocumentContract } from '@cat-factory/contracts'
import { expect, userEvent, waitFor, within } from 'storybook/test'
import { apiPending, apiResponse } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { sourceDocument, sourceDocuments } from '~/stories/integrations.stories.mocks'
import { seedWorkspace, withSeed } from '~/stories/withStores'
import DocumentSyncState from './DocumentSyncState.vue'

// The line under an imported document: when its body was last written, and a button (Check for
// changes) that asks the source whether that is still the current revision. The answer exists
// only after a click, so the verdict stories click it and answer the request: a confirmation says
// what the check found, and a failure says why. A Figma frame also says when its images were not
// all rendered. The revision and when it was checked are in the verdict's hover title. The version tokens are the
// sources' own kinds (a Confluence page number, a Figma file version), made up.
const figmaFrame = sourceDocuments.find((d) => d.source === 'figma')!

const meta = {
  title: 'Documents/Components/DocumentSyncState',
  component: DocumentSyncState,
  args: { doc: sourceDocument() },
  decorators: [withSeed(seedWorkspace)],
  parameters: { width: 'panel' },
} satisfies Meta<typeof DocumentSyncState>
export default meta

type Story = StoryObj<typeof meta>

/** The refresh answer for `doc`: the row, unchanged, with the verdict. */
function refreshed(doc: SourceDocument, freshness: DocumentFreshness) {
  return apiResponse(refreshDocumentContract, {
    pathPrefix: storyWorkspacePrefix,
    body: { document: doc, freshness },
  })
}

async function clickRefresh(canvasElement: HTMLElement) {
  await userEvent.click(within(canvasElement).getByRole('button', { name: 'Check for changes' }))
}

/** Clicks the check, then waits for the verdict line that the answer draws. */
async function clickAndFind(canvasElement: HTMLElement, verdict: string) {
  await clickRefresh(canvasElement)
  await within(canvasElement).findByText(verdict)
}

/** A Confluence page nobody has checked: when it was written, and the check button. */
export const Default: Story = {}

/**
 * A document handed to the platform through the API: there is no source to ask, so there is no
 * check button.
 */
export const Uploaded: Story = {
  args: {
    doc: sourceDocument({
      source: 'upload',
      externalId: 'doc_8f2k1x',
      title: 'Session lifecycle notes',
      url: '',
      renderStatus: null,
    }),
  },
}

/** A Figma frame whose images were only partly rendered. */
export const RendersPartial: Story = { args: { doc: figmaFrame } }

/** A Figma frame whose images could not be rendered at all. */
export const RendersFailed: Story = { args: { doc: { ...figmaFrame, renderStatus: 'failed' } } }

/** The check is in flight: the button spins. */
export const Refreshing: Story = {
  parameters: {
    api: [apiPending(refreshDocumentContract, { pathPrefix: storyWorkspacePrefix })],
  },
  play: async ({ canvasElement }) => {
    await clickRefresh(canvasElement)
    // A loading button is disabled until the answer comes.
    const button = within(canvasElement).getByRole('button', { name: 'Check for changes' })
    await waitFor(() => expect(button).toBeDisabled())
  },
}

/** The page is still at version 14: a check that the copy matches the source. */
export const Confirmed: Story = {
  parameters: {
    api: [refreshed(sourceDocument(), { status: 'confirmed', version: '14', change: 'unchanged' })],
  },
  play: async ({ canvasElement }) => clickAndFind(canvasElement, 'Matches the source'),
}

/**
 * The Figma file moved on, but nothing in this frame changed: the line says only the revision
 * moved, so nobody reads it as their own edit having landed.
 */
export const RevisionOnly: Story = {
  args: { doc: figmaFrame },
  parameters: {
    api: [
      refreshed(figmaFrame, {
        status: 'confirmed',
        version: '2154981532829174',
        change: 'revision_only',
      }),
    ],
  },
  play: async ({ canvasElement }) =>
    clickAndFind(canvasElement, 'The source moved on, but this copy is unchanged'),
}

/** The source could not be reached: a warning that the stored copy stands unconfirmed. */
export const Unconfirmed: Story = {
  parameters: {
    api: [refreshed(sourceDocument(), { status: 'unconfirmed', reason: 'source_unreachable' })],
  },
  play: async ({ canvasElement }) =>
    clickAndFind(canvasElement, 'Not checked: the source could not be reached.'),
}
