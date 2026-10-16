import type { Meta, StoryObj } from '@storybook/vue3'
import type { SourceDocument } from '@cat-factory/contracts'
import { listDocumentRoleLinksContract, listDocumentsContract } from '@cat-factory/contracts'
import { apiFailure, apiResponse } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { sourceDocument, sourceDocuments } from '~/stories/integrations.stories.mocks'
import { seedWorkspace, withSeed } from '~/stories/withStores'
import { useUiStore } from '~/stores/ui'
import DocumentTemplatesModal from './DocumentTemplatesModal.vue'

// The workspace's templates and examples per document kind: one imported document can be the
// template a kind's authors start from, and any number can be examples they study. A document
// carries one tag at most, so the picker leaves out the ones already tagged. It loads the imported
// documents and the tagged ones when it opens, so each story answers both reads. The modal opens
// on the PRD kind. Linking and removing send requests no story answers.

/** A second PRD, tagged as an example to study. */
const billingPrd = sourceDocument({
  externalId: '47388120',
  title: 'Billing service PRD',
  url: 'https://acme.atlassian.net/wiki/spaces/BILL/pages/47388120',
  excerpt: 'Invoices, proration and dunning for the self-serve plans.',
  role: 'exemplar',
  docKind: 'prd',
})

const withExemplar: SourceDocument[] = [...sourceDocuments, billingPrd]
/** The PRD template from the shared fixture, and the billing PRD as its example. */
const roleLinks: SourceDocument[] = withExemplar.filter((d) => d.role !== null)

function answers(documents: SourceDocument[], links: SourceDocument[]) {
  return [
    apiResponse(listDocumentsContract, { pathPrefix: storyWorkspacePrefix, body: documents }),
    apiResponse(listDocumentRoleLinksContract, { pathPrefix: storyWorkspacePrefix, body: links }),
  ]
}

const meta = {
  title: 'Documents/Components/DocumentTemplatesModal',
  component: DocumentTemplatesModal,
  decorators: [
    withSeed(() => {
      seedWorkspace()
      useUiStore().openDocumentTemplates()
    }),
  ],
  parameters: { api: answers(withExemplar, roleLinks) },
} satisfies Meta<typeof DocumentTemplatesModal>
export default meta

type Story = StoryObj<typeof meta>

/**
 * PRD has a template and one example. The picker offers the three imported documents that carry
 * no tag.
 */
export const Default: Story = {}

/** Nothing imported yet: a template has to be an imported document, so the modal offers Import. */
export const Empty: Story = { parameters: { api: answers([], []) } }

/** Documents imported but none tagged: each section says it is empty, and the picker lists all four. */
export const NoLinks: Story = {
  parameters: {
    api: answers(
      sourceDocuments.map((d) => ({ ...d, role: null })),
      [],
    ),
  },
}

/**
 * The tagged documents could not be read: a toast says so, and the sections show no links,
 * because the tags were never loaded.
 */
export const Failed: Story = {
  parameters: {
    api: [
      apiResponse(listDocumentsContract, {
        pathPrefix: storyWorkspacePrefix,
        body: withExemplar,
      }),
      apiFailure(listDocumentRoleLinksContract, { pathPrefix: storyWorkspacePrefix }),
    ],
  },
}
