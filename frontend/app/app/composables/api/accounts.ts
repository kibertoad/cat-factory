import type {
  Account,
  AccountInvitation,
  AccountMember,
  AccountRole,
  AddMemberInput,
  EmailConnection,
  UpdateAccountInput,
} from '~/types/domain'
import type { AccountSettingsView, UpdateAccountSettingsInput } from '~/types/accountSettings'
import type { ApiContext } from './context'

/** Account (tenancy) management: orgs, members, invitations + the email sender. */
export function accountsApi({ http }: ApiContext) {
  return {
    // ---- accounts (tenancy) -----------------------------------------------
    // The accounts the user can switch between (personal + orgs), org creation
    // and membership management. Empty when auth is disabled (dev).
    listAccounts: () => http<Account[]>('/accounts'),

    createAccount: (body: { name: string; githubAccountLogin?: string }) =>
      http<Account>('/accounts', { method: 'POST', body }),

    updateAccount: (accountId: string, body: UpdateAccountInput) =>
      http<Account>(`/accounts/${encodeURIComponent(accountId)}`, { method: 'PATCH', body }),

    listAccountMembers: (accountId: string) =>
      http<AccountMember[]>(`/accounts/${encodeURIComponent(accountId)}/members`),

    addAccountMember: (accountId: string, body: AddMemberInput) =>
      http<AccountMember>(`/accounts/${encodeURIComponent(accountId)}/members`, {
        method: 'POST',
        body,
      }),

    setMemberRoles: (accountId: string, userId: string, roles: AccountRole[]) =>
      http<AccountMember>(
        `/accounts/${encodeURIComponent(accountId)}/members/${encodeURIComponent(userId)}/roles`,
        { method: 'PATCH', body: { roles } },
      ),

    // Invitations: invite teammates by email into an org account.
    listInvitations: (accountId: string) =>
      http<AccountInvitation[]>(`/accounts/${encodeURIComponent(accountId)}/invitations`),

    createInvitation: (accountId: string, body: { email: string; roles?: AccountRole[] }) =>
      http<{ invitation: AccountInvitation; acceptUrl: string | null }>(
        `/accounts/${encodeURIComponent(accountId)}/invitations`,
        { method: 'POST', body },
      ),

    revokeInvitation: (accountId: string, invitationId: string) =>
      http(
        `/accounts/${encodeURIComponent(accountId)}/invitations/${encodeURIComponent(invitationId)}`,
        { method: 'DELETE' },
      ),

    // Per-account email sender (UI-onboarded): connect/inspect/disconnect/test.
    getEmailConnection: (accountId: string) =>
      http<{ connection: EmailConnection | null; configured: boolean }>(
        `/accounts/${encodeURIComponent(accountId)}/email-connection`,
      ),

    connectEmail: (
      accountId: string,
      body: { provider: 'sendgrid' | 'resend'; apiKey: string; fromAddress: string },
    ) =>
      http<EmailConnection>(`/accounts/${encodeURIComponent(accountId)}/email-connection`, {
        method: 'POST',
        body,
      }),

    disconnectEmail: (accountId: string) =>
      http(`/accounts/${encodeURIComponent(accountId)}/email-connection`, { method: 'DELETE' }),

    testEmail: (accountId: string, to: string) =>
      http<{ ok: boolean }>(`/accounts/${encodeURIComponent(accountId)}/email-connection/test`, {
        method: 'POST',
        body: { to },
      }),

    // Per-account deployment settings (admin only): integration secrets (Slack OAuth +
    // web-search keys), sealed at rest. Read returns config + non-secret summary only.
    getAccountSettings: (accountId: string) =>
      http<AccountSettingsView>(`/accounts/${encodeURIComponent(accountId)}/settings`),

    updateAccountSettings: (accountId: string, body: UpdateAccountSettingsInput) =>
      http<AccountSettingsView>(`/accounts/${encodeURIComponent(accountId)}/settings`, {
        method: 'PUT',
        body,
      }),
  }
}
