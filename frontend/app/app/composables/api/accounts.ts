import {
  addAccountMemberContract,
  connectEmailContract,
  createAccountContract,
  createInvitationContract,
  disconnectEmailContract,
  getAccountSettingsContract,
  getEmailConnectionContract,
  listAccountMembersContract,
  listAuditEventsContract,
  listAccountsContract,
  listInvitationsContract,
  revokeInvitationContract,
  revokeMemberSessionsContract,
  setMemberRolesContract,
  testEmailContract,
  updateAccountContract,
  updateAccountSettingsContract,
} from '@cat-factory/contracts'
import type { AccountRole, UpdateAccountInput } from '~/types/domain'
import type { UpdateAccountSettingsInput } from '~/types/accountSettings'
import type { ApiContext } from './context'

/** Account (tenancy) management: orgs, members, invitations + the email sender. */
export function accountsApi({ send }: ApiContext) {
  return {
    // ---- accounts (tenancy) -----------------------------------------------
    // The accounts the user can switch between (personal + orgs), org creation
    // and membership management. Empty when auth is disabled (dev).
    listAccounts: () => send(listAccountsContract, {}),

    createAccount: (body: { name: string; githubAccountLogin?: string }) =>
      send(createAccountContract, { body }),

    updateAccount: (accountId: string, body: UpdateAccountInput) =>
      send(updateAccountContract, { pathParams: { accountId }, body }),

    listAccountMembers: (accountId: string) =>
      send(listAccountMembersContract, { pathParams: { accountId } }),

    addAccountMember: (accountId: string, body: { userId: string; roles?: AccountRole[] }) =>
      send(addAccountMemberContract, { pathParams: { accountId }, body }),

    setMemberRoles: (accountId: string, userId: string, roles: AccountRole[]) =>
      send(setMemberRolesContract, { pathParams: { accountId, userId }, body: { roles } }),

    // End every session a member holds, without touching their membership or roles: the
    // offboarding lever for a departure or a lost device. Admin-only (enforced server-side).
    revokeMemberSessions: (accountId: string, userId: string) =>
      send(revokeMemberSessionsContract, { pathParams: { accountId, userId } }),

    // One page of the account's audit log, newest first. `cursor` is opaque and comes straight
    // back from a previous page; the server clamps `limit`.
    listAuditEvents: (accountId: string, query: { cursor?: string; limit?: number } = {}) =>
      send(listAuditEventsContract, { pathParams: { accountId }, queryParams: query }),

    // Invitations: invite teammates by email into an org account.
    listInvitations: (accountId: string) =>
      send(listInvitationsContract, { pathParams: { accountId } }),

    createInvitation: (accountId: string, body: { email: string; roles?: AccountRole[] }) =>
      send(createInvitationContract, { pathParams: { accountId }, body }),

    revokeInvitation: (accountId: string, invitationId: string) =>
      send(revokeInvitationContract, { pathParams: { accountId, invitationId } }),

    // Per-account email sender (UI-onboarded): connect/inspect/disconnect/test.
    getEmailConnection: (accountId: string) =>
      send(getEmailConnectionContract, { pathParams: { accountId } }),

    connectEmail: (
      accountId: string,
      body: { provider: 'sendgrid' | 'resend'; apiKey: string; fromAddress: string },
    ) => send(connectEmailContract, { pathParams: { accountId }, body }),

    disconnectEmail: (accountId: string) =>
      send(disconnectEmailContract, { pathParams: { accountId } }),

    testEmail: (accountId: string, to: string) =>
      send(testEmailContract, { pathParams: { accountId }, body: { to } }),

    // Per-account deployment settings (admin only): integration secrets (Slack OAuth +
    // web-search keys), sealed at rest. Read returns config + non-secret summary only.
    getAccountSettings: (accountId: string) =>
      send(getAccountSettingsContract, { pathParams: { accountId } }),

    updateAccountSettings: (accountId: string, body: UpdateAccountSettingsInput) =>
      send(updateAccountSettingsContract, { pathParams: { accountId }, body }),
  }
}
