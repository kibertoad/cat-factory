import * as v from 'valibot'

// ---------------------------------------------------------------------------
// Account tenancy wire contracts. An account is the tenant that owns workspaces:
// either a single user's `personal` account or an `org` shared by many engineers.
// Memberships map GitHub users to accounts with a role. A GitHub App installation
// is bound to an account, so every workspace in it can link the account's repos.
// ---------------------------------------------------------------------------

export const accountTypeSchema = v.picklist(['personal', 'org'])
export type AccountType = v.InferOutput<typeof accountTypeSchema>

export const accountRoleSchema = v.picklist(['owner', 'member'])
export type AccountRole = v.InferOutput<typeof accountRoleSchema>

/** An account as exposed to clients, annotated with the caller's role in it. */
export const accountSchema = v.object({
  id: v.string(),
  type: accountTypeSchema,
  name: v.string(),
  /** The GitHub org/user login this account maps to, when known. */
  githubAccountLogin: v.nullable(v.string()),
  createdAt: v.number(),
  /** The signed-in caller's role in this account (`null` in the auth-disabled path). */
  role: v.nullable(accountRoleSchema),
})
export type Account = v.InferOutput<typeof accountSchema>

/** A member of an account. */
export const accountMemberSchema = v.object({
  accountId: v.string(),
  userId: v.number(),
  role: accountRoleSchema,
  createdAt: v.number(),
})
export type AccountMember = v.InferOutput<typeof accountMemberSchema>

// ---- Request bodies -------------------------------------------------------

/** Create a shared org account (the caller becomes its first owner). */
export const createAccountSchema = v.object({
  name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120)),
  /** Optional GitHub org login this account maps to. */
  githubAccountLogin: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(120))),
})
export type CreateAccountInput = v.InferOutput<typeof createAccountSchema>

/** Add a member to an account by their GitHub numeric user id. */
export const addMemberSchema = v.object({
  userId: v.pipe(v.number(), v.integer(), v.minValue(1)),
  role: v.optional(accountRoleSchema),
})
export type AddMemberInput = v.InferOutput<typeof addMemberSchema>
