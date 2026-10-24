import type { Meta, StoryObj } from '@storybook/vue3'
import type { GateConfigForm } from '@cat-factory/contracts'
import { listWorkspaceMembersContract } from '@cat-factory/contracts'
import { workspaceMembers } from '~/stories/accounts.stories.mocks'
import { apiResponse } from '~/stories/api'
import { STORY_WORKSPACE_ID } from '~/stories/workspace'
import { seedWorkspace, withSeed } from '~/stories/withStores'
import { usePipelinesStore } from '~/stores/pipelines'
import GateConfigFields from './GateConfigFields.vue'

// How one step's checkpoint behaves, in the pipeline builder. With a human approval gate on the
// step: which roles and which people may approve, and how many must. Under it, the parameters the
// step's own gate declares, when it declares any. Nothing set means anyone who may write to the
// board can approve, once. It loads the board's members for the people picker, so the gated
// stories answer that read.
//
// No gate that ships declares parameters; a deployment registers its own. This one, a staging
// smoke test, is made up.
const smokeGate: GateConfigForm = {
  kind: 'staging-smoke',
  fields: [
    {
      key: 'url',
      label: 'Health URL',
      type: 'text',
      placeholder: 'https://staging.acme.dev/health',
    },
    {
      key: 'maxAttempts',
      label: 'Attempts',
      type: 'number',
      default: '3',
      min: 1,
      max: 5,
      integer: true,
      help: 'How many times to probe before the gate fails.',
    },
  ],
}

const roster = apiResponse(listWorkspaceMembersContract, {
  pathParams: { workspaceId: STORY_WORKSPACE_ID },
  body: workspaceMembers,
})

function withGate(setup: (pipelines: ReturnType<typeof usePipelinesStore>) => void = () => {}) {
  return withSeed(() => {
    seedWorkspace()
    const pipelines = usePipelinesStore()
    pipelines.gateConfigForms = [smokeGate]
    setup(pipelines)
  })
}

const meta = {
  title: 'Pipeline/Components/GateConfigFields',
  component: GateConfigFields,
  args: { index: 0, gated: true, kind: 'architect' },
  parameters: { width: 'panel', api: [roster] },
  decorators: [withGate()],
} satisfies Meta<typeof GateConfigFields>
export default meta

type Story = StoryObj<typeof meta>

/** The architect's approval gate, limited to admins and Priya, with two approvals. */
export const Default: Story = {
  decorators: [
    withGate((pipelines) =>
      pipelines.patchDraftGateConfig(0, {
        approvers: { roles: ['admin'], userIds: ['usr_priya'] },
        minApprovals: 2,
      }),
    ),
  ],
}

/** No rule: the line that says anyone who may write can approve. */
export const AnyoneMayApprove: Story = {}

/** A step that runs the smoke gate and has no approval gate: only the gate's own parameters. */
export const GateParameters: Story = { args: { gated: false, kind: 'staging-smoke' } }

/** The smoke gate with an approval gate too, and a health URL filled in. */
export const GatedWithParameters: Story = {
  args: { kind: 'staging-smoke' },
  decorators: [
    withGate((pipelines) =>
      pipelines.patchDraftGateConfig(0, {
        fields: { url: 'https://staging.acme.dev/health' },
      }),
    ),
  ],
}
