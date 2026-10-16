// Accounts, account settings, workspace members and invitations, for the account, team and board
// switcher stories. The shared workspace (`STORY_WORKSPACE_ID`) belongs to the Acme org account.
import type {
  Account,
  AccountInvitation,
  AccountMember,
  AccountSettingsView,
  EmailConnection,
  WorkspaceListItem,
  WorkspaceMember,
} from '@cat-factory/contracts'
import type { AuthUser } from '~/types/domain'
import { STORY_WORKSPACE_ID } from './workspace'

/** The org the story workspace belongs to. The viewer is an admin there. */
export const orgAccount: Account = {
  id: 'acct_acme',
  type: 'org',
  name: 'Acme',
  githubAccountLogin: 'acme',
  createdAt: Date.UTC(2026, 7, 1),
  roles: ['admin'],
  spendMonthlyLimit: 500,
}

/**
 * The signed-in user, as `/auth/me` answers. The SPA types this itself (`AuthUser`), so there is
 * no contract schema to check it against.
 */
export const signedInUser: AuthUser = {
  id: 'usr_maya',
  login: 'mlindqvist',
  name: 'Maya Lindqvist',
  avatarUrl: null,
  email: 'maya@acme.dev',
}

/** The viewer's own personal account. */
export const personalAccount: Account = {
  id: 'acct_maya',
  type: 'personal',
  name: 'Maya Lindqvist',
  githubAccountLogin: 'mlindqvist',
  createdAt: Date.UTC(2026, 7, 1),
  roles: ['admin'],
}

export const accounts: Account[] = [orgAccount, personalAccount]

function board(overrides: Partial<WorkspaceListItem> & Pick<WorkspaceListItem, 'id' | 'name'>) {
  return {
    description: null,
    createdAt: Date.UTC(2026, 8, 1),
    accountId: orgAccount.id,
    ...overrides,
  }
}

/**
 * The boards the viewer can see: three in the Acme org and one in the personal account. Core
 * services is the story workspace, Payments is restricted to its roster, and on Mobile app the
 * viewer is only a viewer.
 */
export const accountBoards: WorkspaceListItem[] = [
  board({ id: STORY_WORKSPACE_ID, name: 'Core services', viewerRole: 'admin' }),
  board({
    id: 'ws_payments',
    name: 'Payments platform',
    accessMode: 'restricted',
    viewerRole: 'member',
  }),
  board({ id: 'ws_mobile', name: 'Mobile app', viewerRole: 'viewer' }),
  board({ id: 'ws_sandbox', name: 'Sandbox', accountId: personalAccount.id, viewerRole: 'admin' }),
]

/**
 * The org's settings as `getAccountSettingsContract` answers for an account that has changed
 * nothing yet: no stored config, Slack OAuth registered, content stored in the database.
 */
export const accountSettingsView: AccountSettingsView = {
  config: {},
  summary: {
    slackOAuthConfigured: true,
    linearOAuthConfigured: false,
    figmaOAuthConfigured: false,
    webSearch: null,
    contentStorage: {
      backend: 'db',
      bucket: null,
      basePath: null,
      s3CredentialsConfigured: false,
      customStoreId: null,
    },
  },
  contentStorageCapability: {
    supportedBackends: ['off', 'db', 's3'],
    defaultBackend: 'db',
    customStores: [],
  },
}

function member(
  overrides: Partial<WorkspaceMember> & Pick<WorkspaceMember, 'userId'>,
): WorkspaceMember {
  return {
    workspaceId: STORY_WORKSPACE_ID,
    role: 'member',
    createdAt: Date.UTC(2026, 8, 2),
    addedBy: 'usr_maya',
    avatarUrl: null,
    ...overrides,
  }
}

/** An admin who created the workspace, a member and a viewer. */
export const workspaceMembers: WorkspaceMember[] = [
  member({
    userId: 'usr_maya',
    role: 'admin',
    createdAt: Date.UTC(2026, 8, 1),
    addedBy: null,
    name: 'Maya Lindqvist',
    email: 'maya@acme.dev',
  }),
  member({ userId: 'usr_priya', name: 'Priya Natarajan', email: 'priya@acme.dev' }),
  member({ userId: 'usr_tomas', role: 'viewer', name: 'Tomás Ruiz', email: 'tomas@acme.dev' }),
]

/**
 * The Acme account's roster: Maya is the admin, Priya and Jonas hold the product role (the
 * people a task can name as responsible), and Tomás is a developer.
 */
export const accountMembers: AccountMember[] = [
  {
    accountId: orgAccount.id,
    userId: 'usr_maya',
    roles: ['admin', 'developer'],
    createdAt: Date.UTC(2026, 8, 1),
    name: 'Maya Lindqvist',
    email: 'maya@acme.dev',
  },
  {
    accountId: orgAccount.id,
    userId: 'usr_priya',
    roles: ['product'],
    createdAt: Date.UTC(2026, 8, 2),
    name: 'Priya Natarajan',
    email: 'priya@acme.dev',
  },
  {
    accountId: orgAccount.id,
    userId: 'usr_jonas',
    roles: ['product', 'developer'],
    createdAt: Date.UTC(2026, 8, 9),
    name: 'Jonas Weber',
    email: 'jonas@acme.dev',
  },
  {
    accountId: orgAccount.id,
    userId: 'usr_tomas',
    roles: ['developer'],
    createdAt: Date.UTC(2026, 8, 12),
    name: 'Tomás Ruiz',
    email: 'tomas@acme.dev',
  },
]

/** The Acme account's sender for its e-mail. */
export const resendConnection: EmailConnection = {
  provider: 'resend',
  fromAddress: 'cat-factory@acme.dev',
  connectedAt: Date.UTC(2026, 8, 4),
}

function invitation(
  overrides: Partial<AccountInvitation> & Pick<AccountInvitation, 'id' | 'email'>,
): AccountInvitation {
  return {
    accountId: orgAccount.id,
    roles: ['developer'],
    status: 'pending',
    invitedBy: signedInUser.id,
    expiresAt: Date.UTC(2026, 9, 20),
    createdAt: Date.UTC(2026, 9, 13),
    ...overrides,
  }
}

/** One invitation to Acme waiting, one taken up, and the contractor's, which was withdrawn. */
export const invitations: AccountInvitation[] = [
  invitation({ id: 'inv_7h2c', email: 'lena@acme.dev', roles: ['product'] }),
  invitation({ id: 'inv_3k9d', email: 'jonas@acme.dev', status: 'accepted' }),
  invitation({ id: 'inv_8p1q', email: 'contractor@example.com', status: 'revoked' }),
]
