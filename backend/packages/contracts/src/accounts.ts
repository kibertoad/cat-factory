import * as v from 'valibot'
import { cloudProviderSchema } from './compute-provisioning.js'

// ---------------------------------------------------------------------------
// Account tenancy wire contracts. An account is the tenant that owns workspaces:
// either a single user's `personal` account or an `org` shared by many engineers.
// Memberships map GitHub users to accounts with a role. A GitHub App installation
// is bound to an account, so every workspace in it can link the account's repos.
// ---------------------------------------------------------------------------

export const accountTypeSchema = v.picklist(['personal', 'org'])
export type AccountType = v.InferOutput<typeof accountTypeSchema>

// Combinable account roles. `admin` may modify anything about the org account
// (settings, members, invitations, account-scoped credentials); `developer` is the
// default and grants no special powers; `product` people can be set as a task's
// responsible person and are notified when requirement review flags findings. A member
// holds a SET of these (e.g. an admin who is also a product owner).
export const accountRoleSchema = v.picklist(['admin', 'developer', 'product'])
export type AccountRole = v.InferOutput<typeof accountRoleSchema>

/** A member's combinable role set (at least one role). */
export const accountRolesSchema = v.pipe(v.array(accountRoleSchema), v.minLength(1))
export type AccountRoles = v.InferOutput<typeof accountRolesSchema>

/**
 * A monthly spend budget limit in the base pricing currency. `0` is valid and
 * means "no PAID spend" (same semantics as the per-workspace limit). Shared by the
 * account and user budget tiers. An operator-configured env cap
 * (`BUDGET_MAX_MONTHLY_PER_ACCOUNT` / `BUDGET_MAX_MONTHLY_PER_USER`) additionally
 * ceilings whatever value the UI submits.
 */
export const monthlyBudgetLimitSchema = v.pipe(v.number(), v.minValue(0))

/** An account as exposed to clients, annotated with the caller's role in it. */
export const accountSchema = v.object({
  id: v.string(),
  type: accountTypeSchema,
  name: v.string(),
  /** The GitHub org/user login this account maps to, when known. */
  githubAccountLogin: v.nullable(v.string()),
  createdAt: v.number(),
  /** The signed-in caller's roles in this account (`null` in the auth-disabled path). */
  roles: v.nullable(accountRolesSchema),
  /**
   * The cloud provider new services in this account default to (a service may
   * override it). Absent means the built-in {@link DEFAULT_CLOUD_PROVIDER}
   * (`cloudflare`).
   */
  defaultCloudProvider: v.optional(cloudProviderSchema),
  /**
   * The account-tier monthly spend budget (base pricing currency). Null ⇒ no
   * account-level limit configured; the effective account budget then falls back to
   * the operator env cap (`BUDGET_MAX_MONTHLY_PER_ACCOUNT`) if set, else unlimited.
   * See the tiered-budgets initiative.
   */
  spendMonthlyLimit: v.optional(v.nullable(monthlyBudgetLimitSchema)),
})
export type Account = v.InferOutput<typeof accountSchema>

/** A member of an account. */
export const accountMemberSchema = v.object({
  accountId: v.string(),
  userId: v.string(),
  roles: accountRolesSchema,
  createdAt: v.number(),
  /** Display details of the member (resolved from the users table), when available. */
  name: v.optional(v.nullable(v.string())),
  email: v.optional(v.nullable(v.string())),
  avatarUrl: v.optional(v.nullable(v.string())),
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

/** Update an account's settings (default cloud provider + account-tier budget). */
export const updateAccountSchema = v.object({
  defaultCloudProvider: v.optional(cloudProviderSchema),
  /** Account-tier monthly budget; `null` clears the override, absent leaves it. */
  spendMonthlyLimit: v.optional(v.nullable(monthlyBudgetLimitSchema)),
})
export type UpdateAccountInput = v.InferOutput<typeof updateAccountSchema>

/** Add a member to an account by their internal user id. */
export const addMemberSchema = v.object({
  userId: v.pipe(v.string(), v.minLength(1)),
  roles: v.optional(accountRolesSchema),
})
export type AddMemberInput = v.InferOutput<typeof addMemberSchema>

/** Set a member's role set (admin-only). */
export const setMemberRolesSchema = v.object({
  roles: accountRolesSchema,
})
export type SetMemberRolesInput = v.InferOutput<typeof setMemberRolesSchema>

// ---- Invitations ----------------------------------------------------------

export const invitationStatusSchema = v.picklist(['pending', 'accepted', 'revoked'])
export type InvitationStatus = v.InferOutput<typeof invitationStatusSchema>

/** An account invitation as exposed to clients (never carries the raw token). */
export const accountInvitationSchema = v.object({
  id: v.string(),
  accountId: v.string(),
  email: v.string(),
  roles: accountRolesSchema,
  status: invitationStatusSchema,
  invitedBy: v.string(),
  expiresAt: v.number(),
  createdAt: v.number(),
})
export type AccountInvitation = v.InferOutput<typeof accountInvitationSchema>

/** Invite a teammate by email into an org account. */
export const createInvitationSchema = v.object({
  email: v.pipe(v.string(), v.trim(), v.email(), v.maxLength(320)),
  roles: v.optional(accountRolesSchema),
})
export type CreateInvitationInput = v.InferOutput<typeof createInvitationSchema>

// ---- Email sender connection (per-account, UI-onboarded) ------------------

export const emailProviderKindSchema = v.picklist(['sendgrid', 'resend'])
export type EmailProviderKind = v.InferOutput<typeof emailProviderKindSchema>

/** Safe email-connection metadata exposed to clients (never the API key). */
export const emailConnectionSchema = v.object({
  provider: emailProviderKindSchema,
  fromAddress: v.string(),
  connectedAt: v.number(),
})
export type EmailConnection = v.InferOutput<typeof emailConnectionSchema>

/** Connect (or replace) an account's email sender. */
export const connectEmailSchema = v.object({
  provider: emailProviderKindSchema,
  apiKey: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
  fromAddress: v.pipe(v.string(), v.trim(), v.email(), v.maxLength(320)),
})
export type ConnectEmailInput = v.InferOutput<typeof connectEmailSchema>

/** Send a test email through a connected account sender. */
export const testEmailSchema = v.object({
  to: v.pipe(v.string(), v.trim(), v.email(), v.maxLength(320)),
})
export type TestEmailInput = v.InferOutput<typeof testEmailSchema>
