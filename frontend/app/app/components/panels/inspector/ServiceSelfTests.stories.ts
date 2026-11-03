import type { EnvironmentTestRun } from '@cat-factory/contracts'
import type { Meta, StoryObj } from '@storybook/vue3'
import { STORY_WORKSPACE_ID } from '~/stories/workspace'
import { authService, boardBlocks } from '~/stories/board.stories.mocks'
import { partialProbeReport } from '~/stories/envProbe.stories.mocks'
import { seedBoard, seedWorkspace, withSeed } from '~/stories/withStores'
import { useEnvironmentTestStore } from '~/stores/environmentTest'
import ServiceSelfTests from './ServiceSelfTests.vue'

// A service's two self-tests: stand its environment up and tear it down on a throwaway branch,
// and an agent dry run against that environment. Each shows its latest run: the live stage while
// running, the result after. While either runs, both start buttons are disabled. A service with
// no provisioning type has nothing to test, and both buttons are disabled with a line saying so.
const provisioned = { ...authService, provisioning: { type: 'kubernetes' as const } }

function testRun(overrides: Partial<EnvironmentTestRun>): EnvironmentTestRun {
  return {
    id: 'envtest_1',
    workspaceId: STORY_WORKSPACE_ID,
    blockId: authService.id,
    mode: 'provision',
    status: 'succeeded',
    stage: 'done',
    branch: 'cat-factory/self-test-1',
    envUrl: 'https://auth-selftest.preview.example.invalid',
    error: null,
    failedStage: null,
    probe: null,
    probeProgress: null,
    createdAt: Date.UTC(2026, 9, 11, 9, 0, 0),
    updatedAt: Date.UTC(2026, 9, 11, 9, 6, 0),
    ...overrides,
  }
}

const withRuns = (runs: EnvironmentTestRun[]) =>
  withSeed(() => {
    seedBoard(boardBlocks)
    seedWorkspace()
    useEnvironmentTestStore().hydrate(runs, STORY_WORKSPACE_ID)
  })

const meta = {
  title: 'Inspector/Components/ServiceSelfTests',
  component: ServiceSelfTests,
  args: { block: provisioned },
  parameters: { width: 'panel' },
  decorators: [withRuns([])],
} satisfies Meta<typeof ServiceSelfTests>
export default meta

type Story = StoryObj<typeof meta>

/** Never run: both start buttons. */
export const Default: Story = {}

/** The dry run is probing, with the agent's progress; both starts are disabled. */
export const Probing: Story = {
  decorators: [
    withRuns([
      testRun({
        id: 'envtest_2',
        mode: 'agent-probe',
        status: 'running',
        stage: 'probing',
        probeProgress: { completed: 3, inProgress: 1, total: 7 },
      }),
    ]),
  ],
}

/** Both finished: the environment came up, and the dry run's report shows below. */
export const Finished: Story = {
  decorators: [
    withRuns([
      testRun({}),
      testRun({ id: 'envtest_2', mode: 'agent-probe', probe: partialProbeReport }),
    ]),
  ],
}

/** The environment never came up: the failed stage and the error. */
export const Failed: Story = {
  decorators: [
    withRuns([
      testRun({
        status: 'failed',
        stage: 'provisioning',
        failedStage: 'provisioning',
        envUrl: null,
        error: 'Helm release timed out waiting for the deployment to become ready.',
      }),
    ]),
  ],
}

/** No provisioning type: nothing to test. */
export const Infraless: Story = { args: { block: authService } }
