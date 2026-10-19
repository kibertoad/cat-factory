import type { Meta, StoryObj } from '@storybook/vue3'
import {
  decideMcpAuthorizationContract,
  describeMcpAuthorizationContract,
  listWorkspacesContract,
  MCP_AUTHORIZATION_REQUEST_INVALID,
  type McpAuthorizationRequestView,
} from '@cat-factory/contracts'
import type { HttpHandler } from 'msw'
import { expect, screen, userEvent, waitFor } from 'storybook/test'
import { accountBoards } from '~/stories/accounts.stories.mocks'
import { apiPending, apiRefusal, apiResponse } from '~/stories/api'
import { withQuery } from '~/stories/withQuery'
import McpAuthorizeScreen from './McpAuthorizeScreen.vue'

// The consent screen an MCP host's authorization request lands on: who says it is asking, where
// the browser goes back to, the board the issued key may act on and what it may do there. The
// page reads the sealed request from its own query string, so the `withQuery` decorator puts one
// on the preview frame's URL. It then describes the request and lists the person's boards, so
// each story answers those two reads. The host, its address and the sealed value are made up; the
// refusals are the backend's own (`McpAuthorizationConsentController`).

const sealed = { request: 'sealed.mcp.3c8e1f' }

function requestIs(view: Partial<McpAuthorizationRequestView> = {}): HttpHandler {
  return apiResponse(describeMcpAuthorizationContract, {
    body: {
      clientName: 'Acme desktop assistant',
      redirectOrigin: 'http://127.0.0.1:53682',
      defaultScope: 'read',
      ...view,
    },
  })
}

const boards = apiResponse(listWorkspacesContract, { body: accountBoards })

const meta = {
  title: 'Settings/Pages/McpAuthorizeScreen',
  component: McpAuthorizeScreen,
  decorators: [withQuery(['request'], sealed)],
  parameters: { layout: 'fullscreen', api: [requestIs(), boards] },
} satisfies Meta<typeof McpAuthorizeScreen>
export default meta

type Story = StoryObj<typeof meta>

/**
 * The host asks for nothing above the default: the person's four boards, the first picked, and
 * the four access levels with Read only picked.
 */
export const Default: Story = {}

/** The request still being described: placeholder rows. */
export const Loading: Story = {
  parameters: { api: [apiPending(describeMcpAuthorizationContract), boards] },
}

/** The sealed request expired: the screen says so and offers the way back to the app. */
export const Failed: Story = {
  parameters: {
    api: [
      apiRefusal(describeMcpAuthorizationContract, {
        status: 401,
        error: {
          code: 'unauthorized',
          message: 'This authorization request is invalid or has expired',
          details: { reason: MCP_AUTHORIZATION_REQUEST_INVALID },
        },
      }),
      boards,
    ],
  },
}

/** Opened with no request on the URL: nothing is read, and the screen says where to start. */
export const NoRequest: Story = { decorators: [withQuery(['request'], {})] }

/**
 * The host asked for full access: Read only stays picked, and a line says what the host asked
 * for.
 */
export const RequestedScopeDiffers: Story = {
  parameters: { api: [requestIs({ requestedScope: 'admin' }), boards] },
}

/** The person has no board yet: no choices, and Connect is off. */
export const NoBoards: Story = {
  parameters: {
    api: [requestIs(), apiResponse(listWorkspacesContract, { body: [] })],
  },
}

/**
 * The person picks Payments platform, where they are only a member, and the backend refuses to
 * issue a key there. The choices stay, with the refusal above the buttons.
 */
export const DecisionRefused: Story = {
  parameters: {
    api: [
      requestIs(),
      boards,
      apiRefusal(decideMcpAuthorizationContract, {
        status: 403,
        error: {
          code: 'forbidden',
          message: 'This action requires the secrets.manage permission',
          details: { permission: 'secrets.manage' },
        },
      }),
    ],
  },
  play: async () => {
    await userEvent.click(await screen.findByTestId('mcp-authorize-workspace'))
    await userEvent.click(await screen.findByRole('option', { name: 'Payments platform' }))
    // The open menu blocks pointer events on the page until it has closed.
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull())
    await userEvent.click(screen.getByTestId('mcp-authorize-approve'))
    await screen.findByTestId('mcp-authorize-decision-error')
  },
}
