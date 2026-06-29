import { ContractNoBody, defineApiContract } from '@toad-contracts/valibot'
import * as v from 'valibot'
import {
  forgotPasswordSchema,
  passwordLoginSchema,
  resetPasswordSchema,
  signupSchema,
} from '../auth.js'
import { errorResponses, singleStringParam } from './_shared.js'

// ---------------------------------------------------------------------------
// Authentication route contracts. Mounted under `/auth`, so the paths here are
// relative to that prefix. Public endpoints (no auth gate). The OAuth round-trip
// routes (`/login`, `/callback`, `/google/*`) return a browser redirect (or an
// inline error), so their success is modelled as `ContractNoBody`. The JSON
// endpoints (`/config`, `/me`, `/signup`, `/password-login`, invitations) carry
// proper response schemas. See AuthController in @cat-factory/server.
// ---------------------------------------------------------------------------

// Response wrappers that exist only inline in the controller today.
const sessionUserViewSchema = v.object({
  id: v.string(),
  login: v.string(),
  name: v.nullable(v.string()),
  avatarUrl: v.nullable(v.string()),
  email: v.optional(v.nullable(v.string())),
})

/**
 * Local-mode facade signals surfaced to the SPA, present only on the local facade
 * (the Worker/Node facades omit it). This is the single source of truth for the
 * shape: the server's `AppConfig.localMode` derives its type from it (see
 * `@cat-factory/server` config), and the SPA reads the inferred type directly.
 */
/**
 * The source-control providers a PAT login can target. Mirrors kernel's `VcsProvider`
 * (contracts sits below kernel, so it can't import it) — keep the two member lists in
 * step. Drives the local-mode login UI's provider picker + the `/auth/pat` body.
 */
export const vcsProviderSchema = v.picklist(['github', 'gitlab'])
export type VcsProviderWire = v.InferOutput<typeof vcsProviderSchema>

export const localModeConfigSchema = v.object({
  /** True on the local-mode facade (a single developer running the whole product locally). */
  enabled: v.boolean(),
  /**
   * When local mode runs WITHOUT a GitHub PAT, a github.com URL with the needed scopes
   * pre-selected so the developer can create one in a click. Absent once a PAT is set.
   */
  githubPatSetupUrl: v.optional(v.string()),
  /**
   * Source-control PAT login methods the local facade can serve, so the login screen
   * renders the right controls without probing. Absent on non-local facades. The PAT lives
   * server-side in env — the SPA only selects a provider, it never sees a token.
   *  - `configured` — providers with a PAT set server-side (env): a "Sign in with configured
   *    &lt;provider&gt; PAT" button. The ONLY way to sign in (the operational token is the env
   *    PAT too); a provider with no env PAT gets no button.
   *  - `setupUrls`  — per-provider "create a PAT" link with the right scopes pre-selected, so
   *    the "no token configured" notice can deep-link straight to the token page. The server
   *    owns the scopes (they differ per provider), so the SPA renders the link rather than
   *    hard-coding URLs. Keyed by provider; missing entry ⇒ no deep link for it.
   */
  patLogin: v.optional(
    v.object({
      configured: v.array(vcsProviderSchema),
      setupUrls: v.optional(v.record(vcsProviderSchema, v.string())),
    }),
  ),
})
export type LocalModeConfig = v.InferOutput<typeof localModeConfigSchema>

/**
 * The execution backends a deployment can run repo-operating agent containers on. The
 * available set differs per facade — local mode runs them on host Docker (and can
 * delegate to a pool), the Worker runs Cloudflare Containers, Node runs a self-hosted
 * pool. Leaf values are spelled verbatim so the SPA can key static i18n labels off them.
 */
export const executionBackendKindSchema = v.picklist([
  'local-docker',
  'cloudflare-containers',
  'runner-pool',
])
export type ExecutionBackendKind = v.InferOutput<typeof executionBackendKindSchema>

/** Where the Tester's ephemeral environments are provisioned (local compose vs a provider). */
export const testEnvBackendKindSchema = v.picklist(['local-compose', 'environment-provider'])
export type TestEnvBackendKind = v.InferOutput<typeof testEnvBackendKindSchema>

/**
 * The deployment's infrastructure backends, surfaced so the SPA can present a clear
 * selector of what's available + what's active, instead of a bare delegation toggle.
 *
 * NOTE: `/auth/config` is workspace-agnostic, so `active` here is the DEPLOYMENT DEFAULT.
 * In local mode the user's per-workspace choice lives in the workspace-settings delegation
 * booleans, so the SPA computes the EFFECTIVE active from `available` + those booleans —
 * this descriptor only supplies the option set + the deployment-level default.
 */
export const infrastructureCapabilitiesSchema = v.object({
  execution: v.object({
    available: v.array(executionBackendKindSchema),
    active: executionBackendKindSchema,
  }),
  testEnv: v.object({
    available: v.array(testEnvBackendKindSchema),
    active: testEnvBackendKindSchema,
  }),
})
export type InfrastructureCapabilities = v.InferOutput<typeof infrastructureCapabilitiesSchema>

const authConfigViewSchema = v.object({
  enabled: v.boolean(),
  providers: v.object({
    github: v.boolean(),
    password: v.boolean(),
    google: v.boolean(),
  }),
  localMode: v.optional(localModeConfigSchema),
  infrastructure: v.optional(infrastructureCapabilitiesSchema),
})

const meViewSchema = v.object({
  user: v.nullable(sessionUserViewSchema),
  enabled: v.boolean(),
})

const loginResultSchema = v.object({
  token: v.string(),
  user: sessionUserViewSchema,
})

const invitationPeekSchema = v.union([
  v.object({ valid: v.literal(false) }),
  v.object({
    valid: v.literal(true),
    email: v.string(),
    accountName: v.nullable(v.string()),
  }),
])

const acceptInvitationResultSchema = v.object({ accountId: v.string() })

const inviteTokenParams = singleStringParam('token')

export const authConfigContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/config',
  responsesByStatusCode: { 200: authConfigViewSchema, ...errorResponses },
})

// ---- GitHub OAuth (browser redirect) --------------------------------------

export const githubLoginContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/login',
  responsesByStatusCode: { 200: ContractNoBody, ...errorResponses },
})

export const githubCallbackContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/callback',
  responsesByStatusCode: { 200: ContractNoBody, ...errorResponses },
})

// ---- Google OAuth (browser redirect) --------------------------------------

export const googleLoginContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/google/login',
  responsesByStatusCode: { 200: ContractNoBody, ...errorResponses },
})

export const googleCallbackContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/google/callback',
  responsesByStatusCode: { 200: ContractNoBody, ...errorResponses },
})

// ---- Email / password -----------------------------------------------------

export const signupContract = defineApiContract({
  method: 'post',
  pathResolver: () => '/signup',
  requestBodySchema: signupSchema,
  responsesByStatusCode: { 201: loginResultSchema, ...errorResponses },
})

export const passwordLoginContract = defineApiContract({
  method: 'post',
  pathResolver: () => '/password-login',
  requestBodySchema: passwordLoginSchema,
  responsesByStatusCode: { 200: loginResultSchema, ...errorResponses },
})

// ---- Source-control PAT login (local mode) --------------------------------

// Log in as the account a source-control PAT belongs to. `token` omitted ⇒ use the
// server-configured PAT for that provider (the one-click path); `token` present ⇒ the
// user pasted one inline. Returns the same `{ token, user }` as password login. Served
// only where an identity resolver is wired (local mode); 503 otherwise.
export const patLoginContract = defineApiContract({
  method: 'post',
  pathResolver: () => '/pat',
  requestBodySchema: v.object({
    provider: vcsProviderSchema,
    token: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(4000))),
  }),
  responsesByStatusCode: { 200: loginResultSchema, ...errorResponses },
})

// ---- Forgot / reset password ----------------------------------------------

// Request a reset link. ALWAYS succeeds (204) regardless of whether the email is
// registered, so the response can't be used to enumerate accounts.
export const forgotPasswordContract = defineApiContract({
  method: 'post',
  pathResolver: () => '/forgot-password',
  requestBodySchema: forgotPasswordSchema,
  responsesByStatusCode: { 204: ContractNoBody, ...errorResponses },
})

// Redeem a reset token + set a new password (a 400 on an invalid/used/expired token).
export const resetPasswordContract = defineApiContract({
  method: 'post',
  pathResolver: () => '/reset-password',
  requestBodySchema: resetPasswordSchema,
  responsesByStatusCode: { 204: ContractNoBody, ...errorResponses },
})

// ---- Invitations (peek + accept) ------------------------------------------

export const peekInvitationContract = defineApiContract({
  method: 'get',
  requestPathParamsSchema: inviteTokenParams,
  pathResolver: ({ token }) => `/invitations/${token}`,
  responsesByStatusCode: { 200: invitationPeekSchema, ...errorResponses },
})

export const acceptInvitationContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: inviteTokenParams,
  pathResolver: ({ token }) => `/invitations/${token}/accept`,
  requestBodySchema: ContractNoBody,
  responsesByStatusCode: { 200: acceptInvitationResultSchema, ...errorResponses },
})

// ---- Session --------------------------------------------------------------

export const meContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/me',
  responsesByStatusCode: { 200: meViewSchema, ...errorResponses },
})

export const logoutContract = defineApiContract({
  method: 'post',
  pathResolver: () => '/logout',
  requestBodySchema: ContractNoBody,
  responsesByStatusCode: { 204: ContractNoBody, ...errorResponses },
})
