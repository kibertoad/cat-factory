import type { Meta, StoryObj } from '@storybook/vue3'
import { getExecutionContract } from '@cat-factory/contracts'
import { apiFailure, apiPending } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { execution, snapshot } from '~/stories/snapshot.stories.mocks'
import { seedSnapshot, withSeed } from '~/stories/withStores'
import { useExecutionStore } from '~/stores/execution'
import RunDetailLoadState from './RunDetailLoadState.vue'

// The line a step window shows while it asks for the whole run. The board holds each run without
// its steps' prose, so a window that shows the prose asks for the rest when it opens. Until the
// answer lands, the line says it is loading; if the read fails, it says why. For a run the store
// already holds whole, it shows nothing. The seed holds the projected run and starts the read, as
// the window does.
const meta = {
  title: 'Pipeline/Components/RunDetailLoadState',
  component: RunDetailLoadState,
  args: { instanceId: 'exec_login' },
  parameters: { width: 'panel' },
  decorators: [
    withSeed(() => {
      seedSnapshot(snapshot({ executions: [execution({ projected: true })] }))
      void useExecutionStore().ensureFull('exec_login')
    }),
  ],
} satisfies Meta<typeof RunDetailLoadState>
export default meta

type Story = StoryObj<typeof meta>

/** The read is in flight. */
export const Default: Story = {
  parameters: {
    api: [
      apiPending(getExecutionContract, {
        pathPrefix: storyWorkspacePrefix,
        pathParams: { executionId: 'exec_login' },
      }),
    ],
  },
}

/** The read failed: the warning and the reason. */
export const Failed: Story = {
  parameters: {
    api: [
      apiFailure(getExecutionContract, {
        pathPrefix: storyWorkspacePrefix,
        pathParams: { executionId: 'exec_login' },
      }),
    ],
  },
}
