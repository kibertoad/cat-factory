import type { Meta, StoryObj } from '@storybook/vue3'
import { getNotificationSettingsContract } from '@cat-factory/contracts'
import { apiFailure, apiPending, apiRefusal, apiResponse } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { seedWorkspace, withSeed } from '~/stories/withStores'
import { useSlackStore } from '~/stores/slack'
import { useUiStore } from '~/stores/ui'
import NotificationSettingsPanel from './NotificationSettingsPanel.vue'

// Which notifications the board delivers in the app and by email: one row per notification type,
// one switch per channel, each showing the board's override or else the shipped default. Saving
// stores only what differs from the default. Slack and webhooks choose their types where their
// destination is set, so a line points to the Slack window. The window loads the board's
// overrides when it opens, so each story answers that read.
const pathPrefix = storyWorkspacePrefix

function opened(slackAvailable = true) {
  return withSeed(() => {
    seedWorkspace()
    useSlackStore().available = slackAvailable
    useUiStore().openNotificationSettings()
  })
}

const meta = {
  title: 'Settings/Components/NotificationSettingsPanel',
  component: NotificationSettingsPanel,
  decorators: [opened()],
  parameters: {
    api: [
      apiResponse(getNotificationSettingsContract, {
        pathPrefix,
        body: {
          matrix: {
            ci_failed: { email: true },
            pipeline_complete: { in_app: false },
          },
          updatedAt: Date.UTC(2026, 9, 5),
        },
      }),
    ],
  },
} satisfies Meta<typeof NotificationSettingsPanel>
export default meta

type Story = StoryObj<typeof meta>

/** The shipped defaults, with CI failures also emailed and finished pipelines silenced in the app. */
export const Default: Story = {}

/** The overrides read in flight: placeholder rows. */
export const Loading: Story = {
  parameters: { api: [apiPending(getNotificationSettingsContract, { pathPrefix })] },
}

/** The deployment keeps no routing store: a note, and no switches. */
export const Unavailable: Story = {
  parameters: {
    api: [
      apiRefusal(getNotificationSettingsContract, {
        pathPrefix,
        status: 503,
        error: { code: 'unavailable', message: 'The notification manager is not configured' },
      }),
    ],
  },
}

/** The read failed: a warning with Retry, and no Save that would write the defaults over it. */
export const Failed: Story = {
  parameters: { api: [apiFailure(getNotificationSettingsContract, { pathPrefix })] },
}

/** Slack is not available on this deployment: the footer has no link to it. */
export const WithoutSlack: Story = { decorators: [opened(false)] }
