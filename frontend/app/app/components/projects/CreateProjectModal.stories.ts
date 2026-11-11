import type { Meta, StoryObj } from '@storybook/vue3'
import type { PinnableProjectDefinition, ProjectKindDescriptor } from '@cat-factory/contracts'
import { listPinnableProjectDefinitionsContract } from '@cat-factory/contracts'
import { apiResponse } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { boardBlocks } from '~/stories/board.stories.mocks'
import { seedBoard, seedWorkspace, withSeed } from '~/stories/withStores'
import { useProjectsStore } from '~/stores/projects'
import CreateProjectModal from './CreateProjectModal.vue'

// The form that creates a project on the board: a kind, a title, the linked services, and for a
// kind that pins a definition the one it pins with that definition's inputs.
// Create sends a request no story answers.
const meta = {
  title: 'Board/Components/CreateProjectModal',
  component: CreateProjectModal,
  args: { open: true },
} satisfies Meta<typeof CreateProjectModal>
export default meta

type Story = StoryObj<typeof meta>

const planningKind: ProjectKindDescriptor = {
  id: 'planning',
  label: 'Planning',
  description: 'Work that spans services and belongs to none of them.',
  taskTypes: [{ taskType: 'spike', repoAccess: 'linked-read-only' }],
}

const researchKind: ProjectKindDescriptor = {
  id: 'research',
  label: 'Research',
  description: 'Find out how a vendor or system works, and keep what was learned.',
  definition: 'required',
  taskTypes: [{ taskType: 'research', repoAccess: 'linked-read-only' }],
}

const vendorDefinition: PinnableProjectDefinition = {
  kind: 'research',
  key: 'acme:content-integration',
  version: 2,
  title: 'Content platform integration',
  summary: 'How the content platform authenticates, what its API exposes, and its rate limits.',
  inputs: [
    {
      key: 'region',
      label: 'Region',
      type: 'select',
      options: [
        { value: 'eu', label: 'Europe' },
        { value: 'us', label: 'United States' },
      ],
      required: true,
      default: 'eu',
    },
    { key: 'tenant', label: 'Tenant name', type: 'text', placeholder: 'acme-staging' },
  ],
  origin: 'stored',
}

function withKinds(kinds: ProjectKindDescriptor[]) {
  return withSeed(() => {
    seedWorkspace()
    seedBoard(boardBlocks)
    useProjectsStore().kinds = kinds
  })
}

function definitionsResponse(body: PinnableProjectDefinition[]) {
  return {
    api: [
      apiResponse(listPinnableProjectDefinitionsContract, {
        pathPrefix: storyWorkspacePrefix,
        pathParams: { kind: 'research' },
        body,
      }),
    ],
  }
}

/** A kind that pins no definition: a title, a description and the linked services. */
export const Default: Story = {
  decorators: [withKinds([planningKind])],
}

/** A research kind: the definition picker, with the picked definition's inputs below it. */
export const ResearchDefinition: Story = {
  decorators: [withKinds([researchKind, planningKind])],
  parameters: definitionsResponse([vendorDefinition]),
}

/** A research kind on an organization with no definition to pin yet. */
export const NoDefinitions: Story = {
  decorators: [withKinds([researchKind])],
  parameters: definitionsResponse([]),
}
