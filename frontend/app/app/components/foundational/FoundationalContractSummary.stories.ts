import type { Meta, StoryObj } from '@storybook/vue3'
import type { ApiContractFormat, ApiContractSummary } from '~/types/domain'
import FoundationalContractSummary from './FoundationalContractSummary.vue'

// One foundational service's contract manifest, as an architect's catalog carries it: each
// contract's title, format and size, and its indexed operations. An empty operation list says
// why: a format the platform does not index, or a contract that declares nothing. A capped list
// says how many it left out. The contracts are made up.
//
// The callers pass the format labels from the catalog. The render does the same, so the labels
// are the translated ones.
function contract(overrides: Partial<ApiContractSummary> = {}): ApiContractSummary {
  return {
    contractId: 'ctr_files_api',
    format: 'openapi',
    title: 'Files API',
    size: 48_210,
    path: 'docs/openapi.yaml',
    operations: ['GET /files/{id}', 'POST /files', 'DELETE /files/{id}'],
    omittedOperations: 0,
    ...overrides,
  }
}

const meta = {
  title: 'Settings/Components/FoundationalContractSummary',
  component: FoundationalContractSummary,
  parameters: { width: 'panel' },
  args: { contracts: [contract()], formatLabel: {} as Record<ApiContractFormat, string> },
  render: (args) => ({
    components: { FoundationalContractSummary },
    setup() {
      const { t } = useI18n()
      const formatLabel: Record<ApiContractFormat, string> = {
        openapi: t('foundational.format.openapi'),
        'toad-contract': t('foundational.format.toadContract'),
        'lokalise-api-contract': t('foundational.format.lokaliseApiContract'),
        asyncapi: t('foundational.format.asyncapi'),
        graphql: t('foundational.format.graphql'),
        grpc: t('foundational.format.grpc'),
      }
      return { args, formatLabel }
    },
    template: '<FoundationalContractSummary v-bind="args" :format-label="formatLabel" />',
  }),
} satisfies Meta<typeof FoundationalContractSummary>
export default meta

type Story = StoryObj<typeof meta>

/** An OpenAPI document and an AsyncAPI document, each with its operations. */
export const Default: Story = {
  args: {
    contracts: [
      contract(),
      contract({
        contractId: 'ctr_file_events',
        format: 'asyncapi',
        title: 'File events',
        size: 9_874,
        path: 'docs/asyncapi.yaml',
        operations: ['file.uploaded', 'file.deleted'],
      }),
    ],
  },
}

/** No contracts: the warning line. */
export const Empty: Story = { args: { contracts: [] } }

/** A GraphQL schema: the platform does not index its operations, and says so. */
export const NotIndexed: Story = {
  args: {
    contracts: [
      contract({
        contractId: 'ctr_search_graph',
        format: 'graphql',
        title: 'Search graph',
        size: 21_400,
        path: 'schema.graphql',
        operations: [],
      }),
    ],
  },
}

/** An OpenAPI document that declares no operations. */
export const NoOperations: Story = {
  args: { contracts: [contract({ operations: [] })] },
}

/** A capped list: three operations shown, and the count of the 14 left out. */
export const Omitted: Story = {
  args: { contracts: [contract({ omittedOperations: 14 })] },
}
