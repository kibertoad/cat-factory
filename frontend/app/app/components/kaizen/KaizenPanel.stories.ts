import type { Meta, StoryObj } from '@storybook/vue3'
import { getKaizenOverviewContract } from '@cat-factory/contracts'
import { apiPending, apiRefusal, apiResponse } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { gradingHistory, verifiedCombos } from '~/stories/kaizen.stories.mocks'
import { seedWorkspace, withSeed } from '~/stories/withStores'
import { useUiStore } from '~/stores/ui'
import KaizenPanel from './KaizenPanel.vue'

// The Kaizen screen, a full-screen overlay opened from the sidebar: the combos on their way to
// verified (or there), and the workspace's grading history with each grade and its
// recommendations. It is read-only; the engine schedules the gradings and a background sweep runs
// them. The screen loads the overview when it opens, so each story opens it and answers that read.
const meta = {
  title: 'Run telemetry/Pages/KaizenPanel',
  component: KaizenPanel,
  decorators: [
    withSeed(() => {
      seedWorkspace()
      useUiStore().openKaizen()
    }),
  ],
  parameters: {
    api: [
      apiResponse(getKaizenOverviewContract, {
        pathPrefix: storyWorkspacePrefix,
        body: { gradings: gradingHistory, verified: verifiedCombos },
      }),
    ],
  },
} satisfies Meta<typeof KaizenPanel>
export default meta

type Story = StoryObj<typeof meta>

/**
 * Three combos (one verified, two counting towards five) and five gradings: queued, failed with
 * the backend's message, a 3 with two recommendations, a 5 and a 5 with none.
 */
export const Default: Story = {}

/** A new workspace: nothing graded and no combos. */
export const Empty: Story = {
  parameters: {
    api: [
      apiResponse(getKaizenOverviewContract, {
        pathPrefix: storyWorkspacePrefix,
        body: { gradings: [], verified: [] },
      }),
    ],
  },
}

/** The first load in flight: placeholder rows in both columns. */
export const Loading: Story = {
  parameters: {
    api: [apiPending(getKaizenOverviewContract, { pathPrefix: storyWorkspacePrefix })],
  },
}

/** The deployment has no Kaizen grader: the backend's 503, and one line in place of the screen. */
export const NotConfigured: Story = {
  parameters: {
    api: [
      apiRefusal(getKaizenOverviewContract, {
        pathPrefix: storyWorkspacePrefix,
        status: 503,
        error: { code: 'unavailable', message: 'Kaizen is not configured' },
      }),
    ],
  },
}
