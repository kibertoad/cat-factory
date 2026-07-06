import { ContractNoBody, defineApiContract } from '@toad-contracts/valibot'
import * as v from 'valibot'
import {
  forgotPasswordSchema,
  passwordLoginSchema,
  resetPasswordSchema,
  signupSchema,
} from '../auth.js'
import { backendMisconfiguredSchema } from '../config.js'
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
   * True when the local node runs in MOTHERSHIP mode: it keeps no main database and
   * delegates all org/durable state to a hosted mothership over the machine API, while
   * agent/model credentials stay local (the `node:sqlite` store). Lets the SPA label what
   * is stored locally vs on the mothership. Absent/false ⇒ the standard siloed-Postgres
   * local mode. See docs/initiatives/mothership-mode.md.
   */
  mothership: v.optional(v.boolean()),
  /**
   * In mothership mode, the base URL of the hosted mothership. The SPA sends the user there to
   * sign in (the mothership owns identity + the allowlist), then exchanges the returned session
   * for a machine token via the local node. Present only when `mothership` is true.
   */
  mothershipUrl: v.optional(v.string()),
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
    /**
     * The deployment's executor-harness image ref, when it can be known (the local
     * facade's `LOCAL_HARNESS_IMAGE`). Surfaced so the SPA can prefill the image field of
     * a low-config Kubernetes/k3s runner preset; undefined on facades that can't know it
     * (the Worker/Node pools supply their own image per connection).
     */
    suggestedExecutorImage: v.optional(v.string()),
  }),
  testEnv: v.object({
    available: v.array(testEnvBackendKindSchema),
    active: testEnvBackendKindSchema,
  }),
  /**
   * Whether this deployment can host a long-lived, BROWSABLE frontend preview (the
   * `frontendConfig.previewEnabled` toggle on a `frontend` frame). A browsable preview keeps the
   * built app served on a host-reachable URL, which needs a long-lived host serve — so it is a
   * genuine local/node differentiator. The Worker serves only the self-contained UI-test
   * container (built, tested, and torn down with the run), so it reports `supported: false` and
   * the SPA disables the preview toggle there. `supported: true` means the runtime CAN host a
   * preview; a specific frontend still opts in per-frame via `previewEnabled`.
   */
  frontendPreview: v.object({ supported: v.boolean() }),
  /**
   * Whether this deployment supports the account-wide model-family allow/block policy.
   * `true` on the Cloudflare / remote-Node facades and in mothership mode; `false` in
   * plain local mode (a single-developer machine has no account admin to govern). The SPA
   * hides the "Model access policy" admin section when `false`, and the server refuses to
   * store a non-`off` policy there.
   */
  modelPolicy: v.optional(v.object({ supported: v.boolean() })),
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
  /**
   * Source-control PAT login offered on a HOSTED facade (remote node): the user pastes their
   * OWN personal access token to sign in as the account it belongs to, subject to the server's
   * login/org/domain allowlist. Distinct from `localMode.patLogin` (server-configured one-click
   * tokens for a single local developer). Absent ⇒ no PAT login (e.g. the Worker, OAuth-only).
   */
  patLogin: v.optional(v.object({ providers: v.array(vcsProviderSchema) })),
  /**
   * Test-only: the deployment runs with NO authentication (the `TESTING_NO_AUTH` opt-in), so
   * the SPA may render the board anonymously instead of gating to the login screen. Absent ⇒
   * normal gating. Set only by the e2e suite; never on a real deployment.
   */
  testingNoAuth: v.optional(v.boolean()),
  infrastructure: v.optional(infrastructureCapabilitiesSchema),
  /**
   * Set ONLY by the misconfiguration fallback backend: a facade that failed to boot because a
   * mandatory env var / binding is missing serves a minimal app whose `/auth/config` carries this
   * list of problems (never any secret value — just each var's name, meaning, and remedy). Present
   * ⇒ the SPA renders the dedicated "backend misconfigured" screen instead of the login/board.
   * Absent ⇒ a normally-booted backend.
   */
  misconfigured: v.optional(backendMisconfiguredSchema),
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

// ---- Machine-token minting (mothership mode) ------------------------------

// Exchange the caller's mothership SESSION (Authorization: Bearer) for a `machine`-audience
// token scoped to the user's accounts, which a mothership-mode local node then caches and
// presents on every `/internal/persistence` call. Served by any facade acting as a mothership
// (503 otherwise). `requestedAccountIds` may only NARROW the scope to a subset the user owns;
// it can never widen it.
export const mintMachineTokenContract = defineApiContract({
  method: 'post',
  pathResolver: () => '/machine-token',
  requestBodySchema: v.object({
    nodeId: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200))),
    requestedAccountIds: v.optional(v.array(v.string())),
  }),
  responsesByStatusCode: {
    200: v.object({
      token: v.string(),
      exp: v.number(),
      nodeId: v.string(),
      userId: v.string(),
      accountIds: v.array(v.string()),
      // The verified session's user, so a local node can mint its OWN local session for the
      // same person after connecting (the local SPA then has a usable session).
      user: sessionUserViewSchema,
    }),
    ...errorResponses,
  },
})

// Local-mode ONLY: hand the local node a mothership SESSION token (captured by the SPA from
// the mothership OAuth redirect fragment). The node forwards it to the mothership's
// `/auth/machine-token`, caches the returned opaque machine token in its local store, and
// reports the resulting scope. 503 on any non-local facade. Mounted at the app root, so the
// path is absolute (NOT under `/auth`).
export const connectMothershipContract = defineApiContract({
  method: 'post',
  pathResolver: () => '/local/mothership/connect',
  requestBodySchema: v.object({
    session: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(8000)),
  }),
  responsesByStatusCode: {
    // A LOCAL session (minted by the node for the connected mothership user) + the resulting
    // account scope, so the SPA is signed into its own node right after connecting.
    200: v.object({
      accountIds: v.array(v.string()),
      exp: v.number(),
      session: v.string(),
      user: sessionUserViewSchema,
    }),
    ...errorResponses,
  },
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
