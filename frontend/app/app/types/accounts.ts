// ---------------------------------------------------------------------------
// Account tenancy. An account owns workspaces (boards): either a single user's
// `personal` account or an `org` shared by many engineers. Memberships map users
// to accounts with a role. Mirrors the `@cat-factory/contracts` account schemas
// so responses drop straight into the Pinia store.
// ---------------------------------------------------------------------------
//
// All wire shapes are sourced from @cat-factory/contracts (single source of truth).

export type {
  AccountType,
  AccountRole,
  Account,
  AccountMember,
  CreateAccountInput,
  UpdateAccountInput,
  AddMemberInput,
  SetMemberRolesInput,
  AccountInvitation,
  EmailProviderKind,
  EmailConnection,
} from '@cat-factory/contracts'
