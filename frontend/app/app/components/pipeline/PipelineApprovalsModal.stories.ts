import type { Meta, StoryObj } from '@storybook/vue3'
import { listWorkspaceMembersContract } from '@cat-factory/contracts'
import type { Pipeline } from '~/types/domain'
import { workspaceMembers } from '~/stories/accounts.stories.mocks'
import { apiResponse } from '~/stories/api'
import { bugfixPipeline, standardBuild } from '~/stories/pipelines.stories.mocks'
import { snapshot } from '~/stories/snapshot.stories.mocks'
import { STORY_WORKSPACE_ID } from '~/stories/workspace'
import { seedSnapshot, withSeed } from '~/stories/withStores'
import PipelineApprovalsModal from './PipelineApprovalsModal.vue'

// A built-in pipeline's approval checkpoints, opened from its row in the pipeline library. The
// steps are the catalog's and stay as they are; only where the pipeline pauses for a person
// changes. The bug fix ships a checkpoint after its Clarity Review, which stays locked on.
const roster = apiResponse(listWorkspaceMembersContract, {
  pathParams: { workspaceId: STORY_WORKSPACE_ID },
  body: workspaceMembers,
})

function seeded(...pipelines: Pipeline[]) {
  return withSeed(() =>
    seedSnapshot(
      snapshot({
        pipelines,
        pipelineCatalogApprovals: {
          [bugfixPipeline.id]: {
            agentKinds: bugfixPipeline.agentKinds,
            gates: bugfixPipeline.gates ?? [],
          },
        },
      }),
    ),
  )
}

const meta = {
  title: 'Pipeline/Components/PipelineApprovalsModal',
  component: PipelineApprovalsModal,
  args: { open: true, pipeline: standardBuild },
  parameters: { api: [roster] },
  decorators: [seeded(standardBuild, bugfixPipeline)],
} satisfies Meta<typeof PipelineApprovalsModal>
export default meta

type Story = StoryObj<typeof meta>

/** Standard build, with no checkpoint yet. */
export const Default: Story = {}

/** Standard build with a checkpoint once the Architect Reviewer has passed the design. */
export const AfterArchitectReview: Story = {
  args: {
    pipeline: {
      ...standardBuild,
      gates: standardBuild.agentKinds.map((kind) => kind === 'architect-companion'),
    },
  },
}

/** The bug fix: its Clarity Review checkpoint is part of the built-in and stays on. */
export const ShippedCheckpoint: Story = { args: { pipeline: bugfixPipeline } }
