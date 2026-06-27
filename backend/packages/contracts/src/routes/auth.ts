import { ContractNoBody, defineApiContract, withObjectKeys } from '@toad-contracts/valibot'
import * as v from 'valibot'
import { passwordLoginSchema, signupSchema } from '../auth.js'
import { errorResponses } from './_shared.js'

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
export const localModeConfigSchema = v.object({
  /** True on the local-mode facade (a single developer running the whole product locally). */
  enabled: v.boolean(),
  /**
   * When local mode runs WITHOUT a GitHub PAT, a github.com URL with the needed scopes
   * pre-selected so the developer can create one in a click. Absent once a PAT is set.
   */
  githubPatSetupUrl: v.optional(v.string()),
})
export type LocalModeConfig = v.InferOutput<typeof localModeConfigSchema>

const authConfigViewSchema = v.object({
  enabled: v.boolean(),
  providers: v.object({
    github: v.boolean(),
    password: v.boolean(),
    google: v.boolean(),
  }),
  localMode: v.optional(localModeConfigSchema),
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

const inviteTokenParams = withObjectKeys(v.object({ token: v.string() }))

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
