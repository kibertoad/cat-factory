import type { Meta, StoryObj } from '@storybook/vue3'
import type { SlackNotificationSettings } from '@cat-factory/contracts'
import {
  getSlackMemberMappingContract,
  getSlackSettingsContract,
  listSlackChannelsContract,
} from '@cat-factory/contracts'
import { apiResponse } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { slackConnection } from '~/stories/integrations.stories.mocks'
import { seedWorkspace, withSeed } from '~/stories/withStores'
import { useSlackStore } from '~/stores/slack'
import { useUiStore } from '~/stores/ui'
import SlackPanel from './SlackPanel.vue'

// Slack as a second way to deliver the board's notifications: connect a workspace (Add to Slack,
// or a bot token), pick which notification types go to which channel, and map people so a
// message can mention them. With Slack connected the window loads the routes, the member map and
// the channel list when it opens, so the connected stories answer those reads. The channels and
// member ids are made up.
const pathPrefix = storyWorkspacePrefix

function settings(mentionsEnabled: boolean): SlackNotificationSettings {
  return {
    routes: {
      merge_review: { enabled: true, channel: '#eng-reviews' },
      ci_failed: { enabled: true, channel: '#eng-alerts' },
      pipeline_complete: { enabled: false, channel: '' },
    },
    mentionsEnabled,
    updatedAt: Date.UTC(2026, 9, 3),
  }
}

function connectedAnswers(mentionsEnabled: boolean) {
  return [
    apiResponse(getSlackSettingsContract, { pathPrefix, body: settings(mentionsEnabled) }),
    apiResponse(getSlackMemberMappingContract, {
      pathPrefix,
      body: {
        entries: [
          { userId: 'usr_maya', slackUserId: 'U02MAYA001', role: 'engineering' },
          { userId: 'usr_priya', slackUserId: 'U02PRIYA02', role: 'product' },
        ],
      },
    }),
    apiResponse(listSlackChannelsContract, {
      pathPrefix,
      body: {
        channels: [
          { id: 'C01', name: 'eng-reviews', isPrivate: false },
          { id: 'C02', name: 'eng-alerts', isPrivate: false },
          { id: 'C03', name: 'release-room', isPrivate: true },
        ],
      },
    }),
  ]
}

function opened(connected: boolean, oauthEnabled = true) {
  return withSeed(() => {
    seedWorkspace()
    const slack = useSlackStore()
    slack.connection = connected ? slackConnection : null
    slack.oauthEnabled = oauthEnabled
    useUiStore().openSlack()
  })
}

const meta = {
  title: 'Settings/Components/SlackPanel',
  component: SlackPanel,
  decorators: [opened(true)],
  parameters: { api: connectedAnswers(false) },
} satisfies Meta<typeof SlackPanel>
export default meta

type Story = StoryObj<typeof meta>

/** Connected to Acme: merge reviews and CI failures routed, the other types off. */
export const Default: Story = {}

/** Not connected, on a deployment with the Slack app registered: Add to Slack, or a bot token. */
export const NotConnected: Story = { decorators: [opened(false)] }

/** Not connected and no Slack app registered: the bot token field only. */
export const NotConnectedTokenOnly: Story = { decorators: [opened(false, false)] }

/** Mentions on: the member map under the routes, two people with their roles. */
export const MentionsOn: Story = { parameters: { api: connectedAnswers(true) } }
