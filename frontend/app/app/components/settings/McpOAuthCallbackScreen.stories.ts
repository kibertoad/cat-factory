import type { Meta, StoryObj } from '@storybook/vue3'
import { completeToolServerOAuthContract } from '@cat-factory/contracts'
import { apiPending, apiRefusal, apiResponse } from '~/stories/api'
import { STORY_WORKSPACE_ID } from '~/stories/workspace'
import { withQuery } from '~/stories/withQuery'
import McpOAuthCallbackScreen from './McpOAuthCallbackScreen.vue'

// Where a vendor's authorization server sends the browser back after someone approves a remote
// tool server: the page hands the code and state to the authenticated API and says how it went.
// It reads them from the page's own query string, so the `withQuery` decorator puts them on the
// preview frame's URL. The code, state and server are made up.
const CALLBACK_PARAMS = ['code', 'state', 'error', 'error_description']

function withCallbackQuery(params: Record<string, string>) {
  return withQuery(CALLBACK_PARAMS, params)
}

const granted = { code: 'oc_4f9a2c', state: 'sealed.acme-tracker.7d1e' }

const meta = {
  title: 'Settings/Pages/McpOAuthCallbackScreen',
  component: McpOAuthCallbackScreen,
  decorators: [withCallbackQuery(granted)],
  parameters: {
    layout: 'fullscreen',
    api: [
      apiResponse(completeToolServerOAuthContract, {
        body: { serverId: 'acme-tracker', workspaceId: STORY_WORKSPACE_ID },
      }),
    ],
  },
} satisfies Meta<typeof McpOAuthCallbackScreen>
export default meta

type Story = StoryObj<typeof meta>

/** The grant completed: the server's id, and the way back to the app. */
export const Default: Story = {}

/** The grant in flight: a spinner. */
export const Loading: Story = {
  parameters: { api: [apiPending(completeToolServerOAuthContract)] },
}

/**
 * The backend refused the grant: the signed-in user lacks `secrets.manage` on the board. The page
 * reads the message from a field the API error does not have, so it shows its generic line
 * instead of the reason (#2396).
 */
export const Error: Story = {
  parameters: {
    api: [
      apiRefusal(completeToolServerOAuthContract, {
        status: 403,
        error: {
          code: 'forbidden',
          message: 'This action requires the secrets.manage permission',
          details: { permission: 'secrets.manage' },
        },
      }),
    ],
  },
}

/** The person chose Deny at the vendor: the vendor's own description, as it sent it. */
export const Denied: Story = {
  decorators: [
    withCallbackQuery({
      error: 'access_denied',
      error_description: 'The resource owner denied the request.',
    }),
  ],
}

/** A link with no code or state: nothing to complete. */
export const MissingParams: Story = { decorators: [withCallbackQuery({})] }
