import type { Meta, StoryObj } from '@storybook/vue3'
import type { DocumentSearchResult, SourceDocument } from '@cat-factory/contracts'
import {
  listDocumentsContract,
  listGitHubAvailableReposContract,
  resolveDocumentRefContract,
  searchDocumentsContract,
} from '@cat-factory/contracts'
import type { HttpHandler } from 'msw'
import { ref } from 'vue'
import { expect, screen, userEvent, waitFor, within } from 'storybook/test'
import { contextKey, type PendingContext } from '~/composables/useContextLinking'
import { apiFailure, apiHandler, apiPending, apiRefusal, apiResponse } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { githubProbeApi } from '~/stories/githubApi'
import {
  confluenceDescriptor,
  documentConnections,
  documentSources,
  resolvedDocumentRef,
  resolvedDocumentRefWithDroppedScope,
  sourceDocuments,
} from '~/stories/integrations.stories.mocks'
import { repoFilesApi } from '~/stories/repoFilesApi'
import { availableRepos } from '~/stories/vcs.stories.mocks'
import {
  seedDocumentSources,
  seedMember,
  seedVcs,
  seedWorkspace,
  withSeed,
} from '~/stories/withStores'
import ContextDocumentPicker from './ContextDocumentPicker.vue'

// Attach a document to a task as agent context, inline in the add-task form and the inspector.
// The source is always named, and its menu also connects a source the board does not have. A
// searchable source (Confluence) lists the pages already imported, searches the source as you
// type, and checks a pasted link with the source before it can be attached; a source with no
// search (Figma) takes a link only. GitHub Docs picks files out of a repository instead. The
// picker only stages a pick: the caller links it once the task exists. The render keeps the
// picks, so a click shows.
//
// The sources are seeded on the documents store; the imported documents, the search and the
// link check are answered. Search and check wait 300 ms after the last key. The check's refusal
// is the backend's (`refUnresolved` in `DocumentImportService`).
const CONFLUENCE_SHARE_LINK =
  'https://acme.atlassian.net/wiki/spaces/AUTH/pages/48213377/Session+lifecycle?atlOrigin=eyJpIjoiNmQ'
const FIGMA_FRAME_LINK =
  'https://www.figma.com/design/Xq3hT9mPa2Lk/Sign-in?node-id=I2649:14930;2649:14746&t=Qm8xZ1'

/** Pages on the Confluence site: three for "session", one of them already imported. */
const sessionHits: DocumentSearchResult[] = [
  {
    source: 'confluence',
    externalId: '48213377',
    title: 'Session lifecycle',
    url: 'https://acme.atlassian.net/wiki/spaces/AUTH/pages/48213377',
    excerpt: 'How a session is issued, refreshed and revoked.',
  },
  {
    source: 'confluence',
    externalId: '48500112',
    title: 'Session store migration plan',
    url: 'https://acme.atlassian.net/wiki/spaces/AUTH/pages/48500112',
    excerpt: 'Moving sessions from Redis to Postgres.',
  },
  {
    source: 'confluence',
    externalId: '46022870',
    title: 'Incident review: sessions dropped on deploy',
    url: 'https://acme.atlassian.net/wiki/spaces/OPS/pages/46022870',
    excerpt: 'Sessions were lost when the old pods drained too fast.',
  },
]

function documentsAre(body: SourceDocument[]): HttpHandler {
  return apiResponse(listDocumentsContract, { pathPrefix: storyWorkspacePrefix, body })
}

const confluence = {
  pathPrefix: storyWorkspacePrefix,
  pathParams: { source: 'confluence' as const },
}

/** The search: the pages whose title holds the query, as Confluence's title search finds them. */
function searchFinds(pages: DocumentSearchResult[]): HttpHandler {
  return apiHandler(
    searchDocumentsContract,
    { pathPrefix: storyWorkspacePrefix, pattern: { source: 'confluence' } },
    ({ body }) => {
      const query = (body as { query: string }).query.toLowerCase()
      return { results: pages.filter((p) => p.title.toLowerCase().includes(query)) }
    },
  )
}

/** The answers every story needs, then the story's own in front of them. */
function answers(...own: HttpHandler[]): HttpHandler[] {
  return [...own, documentsAre(sourceDocuments), searchFinds(sessionHits)]
}

const meta = {
  title: 'Documents/Components/ContextDocumentPicker',
  component: ContextDocumentPicker,
  args: { chosenKeys: [] },
  parameters: { width: 'panel', api: answers() },
  decorators: [
    withSeed(() => {
      seedWorkspace()
      seedDocumentSources(documentSources, documentConnections)
    }),
  ],
  render: (args) => ({
    components: { ContextDocumentPicker },
    setup() {
      const chosen = ref<string[]>(args.chosenKeys ?? [])
      function pick(item: PendingContext) {
        chosen.value = [...chosen.value, contextKey(item)]
      }
      return { chosen, pick }
    },
    template:
      '<div class="pb-56"><ContextDocumentPicker :chosen-keys="chosen" @pick="pick" /></div>',
  }),
} satisfies Meta<typeof ContextDocumentPicker>
export default meta

type Story = StoryObj<typeof meta>

/** Paste `text` into the search box, as a link is pasted. */
async function paste(canvasElement: HTMLElement, text: string) {
  await userEvent.click(await within(canvasElement).findByRole('textbox'))
  await userEvent.paste(text)
}

/** Pick another source from the source menu. */
async function switchSource(canvasElement: HTMLElement, label: string) {
  await userEvent.click(within(canvasElement).getByRole('button', { name: /Source/ }))
  await userEvent.click(await screen.findByRole('menuitemcheckbox', { name: label }))
}

/** Confluence, nothing typed: the two pages already imported from it. */
export const Default: Story = {}

/** No page imported from Confluence yet: the empty state asks for a search or a link. */
export const Empty: Story = {
  parameters: { api: answers(documentsAre([])) },
}

/**
 * A member on a board with no source connected: the source has no menu, and the empty state
 * says an admin connects one.
 */
export const NoSourceMember: Story = {
  decorators: [
    withSeed(() => {
      seedDocumentSources(documentSources, [])
      seedMember()
    }),
  ],
}

/**
 * "session": the imported Session lifecycle first, then the two other pages the search found.
 * The search also found Session lifecycle, which shows once.
 */
export const SearchResults: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.type(within(canvasElement).getByRole('textbox'), 'session')
    await within(canvasElement).findByText('Session store migration plan')
  },
}

/** The search has not answered yet: the spinner in the box. */
export const Searching: Story = {
  parameters: { api: answers(apiPending(searchDocumentsContract, confluence)) },
  play: async ({ canvasElement }) => {
    await userEvent.type(within(canvasElement).getByRole('textbox'), 'session')
    // The search starts 300 ms after the last key; the box then shows its loading icon, which
    // has no text or role to find it by.
    await waitFor(() => expect(canvasElement.querySelector('.animate-spin')).not.toBeNull())
  },
}

/** The search failed: the line under the box says so, with the error behind "Show details". */
export const SearchFailed: Story = {
  parameters: { api: answers(apiFailure(searchDocumentsContract, confluence)) },
  play: async ({ canvasElement }) => {
    await userEvent.type(within(canvasElement).getByRole('textbox'), 'session')
    await within(canvasElement).findByText(/Search failed/)
  },
}

/**
 * A Confluence share link, with its title and tracking parameter: the source reads it as the
 * imported Session lifecycle page, so the row names that page and says the link was trimmed.
 */
export const RefResolved: Story = {
  parameters: {
    api: answers(
      apiResponse(resolveDocumentRefContract, { ...confluence, body: resolvedDocumentRef }),
    ),
  },
  play: async ({ canvasElement }) => {
    await paste(canvasElement, CONFLUENCE_SHARE_LINK)
    await within(canvasElement).findByTestId('doc-ref-attach')
  },
}

/**
 * Figma, a frame link whose node id the source cannot read: the row attaches the whole file,
 * and says which frame it dropped.
 */
export const RefWidened: Story = {
  parameters: {
    api: answers(
      apiResponse(resolveDocumentRefContract, {
        pathPrefix: storyWorkspacePrefix,
        pathParams: { source: 'figma' },
        body: resolvedDocumentRefWithDroppedScope,
      }),
    ),
  },
  play: async ({ canvasElement }) => {
    await switchSource(canvasElement, 'Figma')
    await paste(canvasElement, FIGMA_FRAME_LINK)
    await within(canvasElement).findByTestId('doc-ref-widened')
  },
}

/** The source has not judged the pasted link yet. */
export const RefChecking: Story = {
  parameters: { api: answers(apiPending(resolveDocumentRefContract, confluence)) },
  play: async ({ canvasElement }) => {
    await paste(canvasElement, CONFLUENCE_SHARE_LINK)
    await within(canvasElement).findByTestId('doc-ref-checking')
  },
}

/**
 * A Figma link pasted into Confluence: the source refuses it, names Figma, and offers to switch,
 * because the board has Figma connected. Nothing can be attached.
 */
export const RefRejected: Story = {
  parameters: {
    api: answers(
      apiRefusal(resolveDocumentRefContract, {
        ...confluence,
        status: 422,
        error: {
          code: 'validation',
          message: `'${FIGMA_FRAME_LINK}' is a figma reference, not a confluence one`,
          details: {
            reason: 'document_ref_claimed_by_other_source',
            source: 'confluence',
            claimedBy: 'figma',
            expected: confluenceDescriptor.refPlaceholder,
          },
        },
      }),
    ),
  },
  play: async ({ canvasElement }) => {
    await paste(canvasElement, FIGMA_FRAME_LINK)
    await within(canvasElement).findByTestId('doc-ref-rejected')
  },
}

/**
 * The check itself failed: the link is not judged, the line says so, and it can still be
 * attached as pasted, for the import to judge.
 */
export const RefUnchecked: Story = {
  parameters: { api: answers(apiFailure(resolveDocumentRefContract, confluence)) },
  play: async ({ canvasElement }) => {
    await paste(canvasElement, CONFLUENCE_SHARE_LINK)
    await within(canvasElement).findByTestId('doc-ref-unchecked')
  },
}

/** The pasted link is a page the task already has: no row, and a line that says so. */
export const RefAlreadyAttached: Story = {
  args: { chosenKeys: [`document:confluence:${resolvedDocumentRef.externalId}`] },
  parameters: {
    api: answers(
      apiResponse(resolveDocumentRefContract, { ...confluence, body: resolvedDocumentRef }),
    ),
  },
  play: async ({ canvasElement }) => {
    await paste(canvasElement, CONFLUENCE_SHARE_LINK)
    await within(canvasElement).findByTestId('doc-ref-already-attached')
  },
}

/** GitHub Docs: the repository and file picker takes the place of the search. */
export const RepoSource: Story = {
  decorators: [withSeed(() => seedVcs())],
  parameters: {
    api: answers(
      apiResponse(listGitHubAvailableReposContract, {
        pathPrefix: storyWorkspacePrefix,
        body: availableRepos,
      }),
      ...githubProbeApi(),
      ...repoFilesApi(),
    ),
  },
  play: async ({ canvasElement }) => {
    await switchSource(canvasElement, 'GitHub Docs')
    await within(canvasElement).findByPlaceholderText('Search repositories…')
  },
}
