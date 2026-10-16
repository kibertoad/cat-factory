import type { Meta, StoryObj } from '@storybook/vue3'
import { listGitHubBranchesContract } from '@cat-factory/contracts'
import { userEvent, within } from 'storybook/test'
import { accountMembers, orgAccount } from '~/stories/accounts.stories.mocks'
import { apiResponse } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { authService, boardBlocks, gatewayService, loginTask } from '~/stories/board.stories.mocks'
import { manualReviewPolicy, modelPreset, riskPolicy } from '~/stories/policies.stories.mocks'
import { claudeOnlyCatalog, modelOption } from '~/stories/providers.stories.mocks'
import { buildPipeline, snapshot } from '~/stories/snapshot.stories.mocks'
import { AUTH_REPO_ID, authBranches } from '~/stories/vcs.stories.mocks'
import { seedModelCatalog, seedSnapshot, seedUiMode, seedVcs, withSeed } from '~/stories/withStores'
import { useAccountsStore } from '~/stores/accounts'
import type { Block } from '~/types/domain'
import TaskRunSettings from './TaskRunSettings.vue'

// How a task runs: its default pipeline, merge policy and model preset, whether it is technical,
// the connected services it also changes, existing branches to hand the run, the tracker
// writeback, the responsible product person, and whether merging it starts its dependents. Basic
// tier hides the groups that only override a board default, unless the task already overrides
// one. The section starts closed, so every story opens it. The board's API Gateway uses the Auth
// Service, so the login task can involve it; the presets, roster and branches are the shared
// fixtures.
const opusPreset = modelPreset({
  id: 'mdp_opus',
  name: 'Claude Opus',
  baseModelId: 'claude-opus',
  isDefault: false,
})

/** A catalog where both presets' models can run: Kimi on Workers AI, and Claude Opus. */
const catalog = [modelOption(), ...claudeOnlyCatalog.filter((m) => m.id === 'claude-opus')]

function seeded(task: Block, options: { advanced?: boolean; models?: typeof catalog } = {}) {
  return withSeed(() => {
    const gateway: Block = {
      ...gatewayService,
      serviceConnections: [{ serviceBlockId: authService.id, description: 'Checks sessions.' }],
    }
    const blocks = boardBlocks.map((b) =>
      b.id === gateway.id ? gateway : b.id === task.id ? task : b,
    )
    seedSnapshot(
      snapshot({
        blocks,
        riskPolicies: [riskPolicy(), manualReviewPolicy],
        modelPresets: [modelPreset(), opusPreset],
      }),
    )
    seedModelCatalog(options.models ?? catalog)
    seedVcs()
    seedUiMode(options.advanced === false ? 'basic' : 'advanced')
    const accounts = useAccountsStore()
    accounts.activeAccountId = orgAccount.id
    accounts.members = accountMembers
  })
}

/** Everything a story can set on the login task, as an advanced user would. */
const configured: Block = {
  ...loginTask,
  pipelineId: buildPipeline.id,
  riskPolicyId: manualReviewPolicy.id,
  modelPresetId: opusPreset.id,
  involvedServiceIds: [gatewayService.id],
  responsibleProductUserId: 'usr_priya',
  aprioriBranches: [{ name: 'spike/refresh-lock', mode: 'reference' }],
}

const meta = {
  title: 'Inspector/Components/TaskRunSettings',
  component: TaskRunSettings,
  args: { block: configured },
  decorators: [seeded(configured)],
  parameters: {
    width: 'panel',
    api: [
      apiResponse(listGitHubBranchesContract, {
        pathPrefix: storyWorkspacePrefix,
        pathParams: { repoGithubId: String(AUTH_REPO_ID) },
        body: authBranches,
      }),
    ],
  },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: /Run settings/ }))
  },
} satisfies Meta<typeof TaskRunSettings>
export default meta

type Story = StoryObj<typeof meta>

/**
 * Advanced tier: the build pipeline, the manual review policy, the Claude Opus preset, API
 * Gateway involved, a branch to read, and Priya responsible.
 */
export const Default: Story = {}

/** Basic tier and nothing overridden: the override groups are gone. */
export const BasicMode: Story = {
  args: { block: loginTask },
  decorators: [seeded(loginTask, { advanced: false })],
}

/** Basic tier, and the task carries a merge policy: that group stays, so it can be seen. */
export const BasicModeWithOverride: Story = {
  args: { block: { ...loginTask, riskPolicyId: manualReviewPolicy.id } },
  decorators: [seeded({ ...loginTask, riskPolicyId: manualReviewPolicy.id }, { advanced: false })],
}

/** The Kimi preset on a deployment with no Workers AI: the warning names the model it lacks. */
export const UnavailablePresetModels: Story = {
  args: { block: { ...configured, modelPresetId: 'mdp_kimi' } },
  decorators: [seeded({ ...configured, modelPresetId: 'mdp_kimi' }, { models: claudeOnlyCatalog })],
}

/** A service the task involved is no longer connected: it shows as a stale badge. */
export const StaleInvolvedService: Story = {
  args: { block: { ...configured, involvedServiceIds: [gatewayService.id, 'svc_billing'] } },
  decorators: [seeded({ ...configured, involvedServiceIds: [gatewayService.id, 'svc_billing'] })],
}

/** A document task: the repositories its writer may read join the section. */
export const DocumentTask: Story = {
  args: { block: { ...configured, taskType: 'document', pipelineId: undefined } },
  decorators: [seeded({ ...configured, taskType: 'document', pipelineId: undefined })],
}
