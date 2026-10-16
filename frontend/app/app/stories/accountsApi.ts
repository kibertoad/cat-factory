// The answers to what an account's Team tab and its sections read when it opens: the e-mail
// sender, the roster, the invitations, the account's API keys, its settings and the audit log.
// For the `AccountTeamSettings` stories and the Account settings window, which opens on that tab.
import {
  getAccountSettingsContract,
  getEmailConnectionContract,
  listAccountMembersContract,
  listAuditEventsContract,
  listInvitationsContract,
} from '@cat-factory/contracts'
import type { Account, EmailConnection } from '@cat-factory/contracts'
import type { HttpHandler } from 'msw'
import {
  accountMembers,
  accountSettingsView,
  invitations,
  orgAccount,
  resendConnection,
} from './accounts.stories.mocks'
import { apiResponse } from './api'
import { auditEvents } from './audit.stories.mocks'
import { accountApiKeys } from './providers.stories.mocks'
import { accountApiKeysApi } from './providersApi'

/** What the Team tab reads for `account`, with the e-mail sender as `email` says. */
export function accountTeamApi(
  account: Account = orgAccount,
  email: { connection: EmailConnection | null; configured: boolean } = {
    connection: resendConnection,
    configured: true,
  },
): HttpHandler[] {
  const pathParams = { accountId: account.id }
  return [
    apiResponse(getEmailConnectionContract, { pathParams, body: email }),
    apiResponse(listAccountMembersContract, { pathParams, body: accountMembers }),
    apiResponse(listInvitationsContract, { pathParams, body: invitations }),
    accountApiKeysApi(account.id === orgAccount.id ? accountApiKeys : [], account.id),
    apiResponse(getAccountSettingsContract, { pathParams, body: accountSettingsView }),
    apiResponse(listAuditEventsContract, {
      pathParams,
      body: { events: auditEvents, nextCursor: null },
    }),
  ]
}
