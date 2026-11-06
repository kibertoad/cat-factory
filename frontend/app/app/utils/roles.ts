import type { AccountRole, WorkspaceRole } from '@cat-factory/contracts'

// Role id → label key, ONE map per role vocabulary, shared by every surface that names a role
// (the pickers, the read-only rosters, the audit log). Exhaustive over the contract unions, so a
// new role fails the typecheck here instead of rendering its id on one surface and a label on
// another.
export const ACCOUNT_ROLE_LABEL_KEYS: Record<AccountRole, string> = {
  admin: 'layout.accountTeam.roles.admin',
  developer: 'layout.accountTeam.roles.developer',
  product: 'layout.accountTeam.roles.product',
}

export const WORKSPACE_ROLE_LABEL_KEYS: Record<WorkspaceRole, string> = {
  admin: 'layout.workspaceMembers.roles.admin',
  member: 'layout.workspaceMembers.roles.member',
  viewer: 'layout.workspaceMembers.roles.viewer',
}
