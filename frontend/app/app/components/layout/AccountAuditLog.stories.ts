import type { Meta, StoryObj } from '@storybook/vue3'
import type { AuditEventWire } from '@cat-factory/contracts'
import { listAuditEventsContract } from '@cat-factory/contracts'
import { apiFailure, apiHandler, apiPending, apiResponse } from '~/stories/api'
import { orgAccount } from '~/stories/accounts.stories.mocks'
import { auditEvents, olderAuditEvents } from '~/stories/audit.stories.mocks'
import AccountAuditLog from './AccountAuditLog.vue'

// The account's audit log for an admin: who did what, newest first, each row composed from a
// translated sentence and the row's own values, with an absolute time. The log loads its first
// page when it mounts, so each story answers that read. A row's actor is a person, an API key or
// the system. The people, ids and times are made up.

function pageIs(page: AuditEventWire[], nextCursor: string | null) {
  return apiResponse(listAuditEventsContract, {
    pathParams: { accountId: orgAccount.id },
    body: { events: page, nextCursor },
  })
}

/** The first page with a cursor, and the older page when the request carries one. */
const pagedLog = apiHandler(
  listAuditEventsContract,
  { pattern: { accountId: ':accountId' } },
  ({ query }) =>
    query.get('cursor')
      ? { events: olderAuditEvents, nextCursor: null }
      : { events: auditEvents, nextCursor: 'cur_aud_03' },
)

const meta = {
  title: 'Settings/Components/AccountAuditLog',
  component: AccountAuditLog,
  args: { accountId: orgAccount.id },
  parameters: { width: 'prose', api: [pagedLog] },
} satisfies Meta<typeof AccountAuditLog>
export default meta

type Story = StoryObj<typeof meta>

/**
 * A person, an API key and the system, and Load older entries under them, because the page has
 * a cursor. Load older entries appends the last page and ends the list.
 */
export const Default: Story = {}

/** The last page: the actor who left shows as their id, and the retired action is named as such. */
export const LastPage: Story = { parameters: { api: [pageIs(olderAuditEvents, null)] } }

/** Nothing recorded yet. */
export const Empty: Story = { parameters: { api: [pageIs([], null)] } }

/** The first page in flight: three placeholder rows. */
export const Loading: Story = {
  parameters: {
    api: [apiPending(listAuditEventsContract, { pathParams: { accountId: orgAccount.id } })],
  },
}

/** The read failed: a message with the reason in place of the list, and no Load older entries. */
export const Failed: Story = {
  parameters: {
    api: [apiFailure(listAuditEventsContract, { pathParams: { accountId: orgAccount.id } })],
  },
}
