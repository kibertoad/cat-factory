import {
  acceptInvitationContract,
  authConfigContract,
  forgotPasswordContract,
  githubCallbackContract,
  githubLoginContract,
  googleCallbackContract,
  googleLoginContract,
  listMachineNodesContract,
  logoutContract,
  meContract,
  mintMachineTokenContract,
  passwordLoginContract,
  revokeMachineNodeContract,
  revokeMySessionsContract,
  patLoginContract,
  peekInvitationContract,
  resetPasswordContract,
  signupContract,
} from '@cat-factory/contracts'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { GitHubOAuth } from '../../auth/GitHubOAuth.js'
import { GoogleOAuth } from '../../auth/GoogleOAuth.js'
import { verifySession } from '../../auth/middleware.js'
import { mintMachineToken } from '../../auth/machineToken.js'
import { passwordAttemptLimited, tooManyAttempts } from './authThrottle.js'
import type { AuthConfig } from '../../config/types.js'
import type { AppEnv } from '../../http/env.js'
import type { VcsIdentity, VcsIdentityResolver } from '@cat-factory/kernel'
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  UnavailableError,
  UnauthorizedError,
} from '@cat-factory/kernel'
import { requireCapability, requireUser } from '../../http/guards.js'
// The mechanics every redirecting login provider shares — the cookie-bound CSRF state, the
// allow-listed post-login redirect, the session mint, the invite handling. Extracted when
// enterprise SSO landed so there is exactly ONE implementation of each (see loginFlow.ts).
import {
  acceptInvite,
  authConfig,
  beginRoundTrip,
  consumeState,
  emailDomainAllowed,
  emailMatchesInvite,
  mintSession,
  sessionGenerationFor,
  peekInvite,
  sessionUser,
  withToken,
} from './loginFlow.js'
import { registerSsoRoutes } from './ssoRoutes.js'

// Authentication endpoints. The SPA is handed a signed session token (via the URL
// fragment for OAuth redirects, or the JSON body for password login) which it carries
// as `Authorization: Bearer` on subsequent calls. Four login providers compose here:
//   - GitHub OAuth (browser round-trip)
//   - Google OAuth (browser round-trip)
//   - enterprise SSO / generic OIDC (browser round-trip, in `ssoRoutes.ts`)
//   - email/password (direct JSON)
// All resolve to ONE canonical `users` row via the UserService, so the session id is
// always the internal `usr_*` id regardless of how the user signed in.

// The one controller that keeps a local thrower rather than `requireCapability`: what it
// guards is a boolean FLAG (`cfg.githubEnabled` / `cfg.passwordEnabled`), not an absent
// value, so there is nothing for the accessor to narrow and return.
/**
 * The Google OAuth client, or a 503. Wraps the nullable `googleClient(cfg)` builder so the two
 * OAuth routes don't restate the refusal.
 */
function requireGoogle(cfg: AuthConfig) {
  return requireCapability(googleClient(cfg), 'Authentication is not configured')
}

const unavailable = (): never => {
  throw new UnavailableError('Authentication is not configured')
}

function githubClient(cfg: AuthConfig): GitHubOAuth {
  return new GitHubOAuth({
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
    apiBase: cfg.apiBase,
    oauthBase: cfg.oauthBase,
  })
}

function googleClient(cfg: AuthConfig): GoogleOAuth | null {
  if (!cfg.google) return null
  return new GoogleOAuth({
    clientId: cfg.google.clientId,
    clientSecret: cfg.google.clientSecret,
    oauthBase: cfg.google.oauthBase,
    apiBase: cfg.google.apiBase,
  })
}

function githubCallbackUrl<E extends AppEnv>(c: Context<E>, cfg: AuthConfig): string {
  if (cfg.callbackUrl) return cfg.callbackUrl
  return `${new URL(c.req.url).origin}/auth/callback`
}

function googleCallbackUrl<E extends AppEnv>(c: Context<E>, cfg: AuthConfig): string {
  if (cfg.google?.redirectUrl) return cfg.google.redirectUrl
  return `${new URL(c.req.url).origin}/auth/google/callback`
}

/**
 * GitHub allowlist gate — the deployment is private. A user is admitted only if their
 * login is in `allowedLogins` OR they belong to an org in `allowedOrgs`. Both lists
 * empty ⇒ deny everyone (fail closed).
 */
async function isGitHubSignInAllowed(
  oauth: GitHubOAuth,
  accessToken: string,
  user: { login: string },
  cfg: Pick<AuthConfig, 'allowedLogins' | 'allowedOrgs'>,
): Promise<boolean> {
  if (cfg.allowedLogins.includes(user.login.toLowerCase())) return true
  if (cfg.allowedOrgs.length === 0) return false
  const orgs = await oauth.fetchUserOrgs(accessToken)
  return orgs.some((org) => cfg.allowedOrgs.includes(org))
}

/**
 * Hosted PAT-login allowlist. A remote deployment has no anonymous tier and must not admit an
 * arbitrary source-control account just because the PAT is valid, so a PAT login is held to
 * the SAME OR gate the rest of auth applies — extended across all three keys the user named:
 * admit when the resolved login is allowlisted (`allowedLogins`), OR an org it belongs to is
 * (`allowedOrgs`, GitHub `read:org`), OR its email domain is (`allowedEmailDomains`, the same
 * rule password/Google self-signup uses). Fail closed: with every list empty, deny — matching
 * `isGitHubSignInAllowed`. Local mode bypasses this (a single developer on their own machine);
 * the caller gates on `config.localMode`.
 */
async function isPatIdentityAllowed(
  cfg: AuthConfig,
  resolver: VcsIdentityResolver,
  identity: VcsIdentity,
  pat: string,
): Promise<{ allowed: boolean; orgLookupFailed: boolean }> {
  if (cfg.allowedLogins.includes(identity.login.toLowerCase())) {
    return { allowed: true, orgLookupFailed: false }
  }
  if (identity.email && emailDomainAllowed(identity.email, cfg)) {
    return { allowed: true, orgLookupFailed: false }
  }
  let orgLookupFailed = false
  if (cfg.allowedOrgs.length > 0 && resolver.resolveOrgs) {
    try {
      const orgs = await resolver.resolveOrgs(pat)
      if (orgs.some((org) => cfg.allowedOrgs.includes(org.toLowerCase()))) {
        return { allowed: true, orgLookupFailed: false }
      }
    } catch {
      // Org enumeration failed (the token lacks org/group-read scope, or a transient API error).
      // Treat as "no qualifying org" rather than admitting — fail closed — but flag it so the
      // caller can hint that the token may simply be missing the org/group-read scope, instead of
      // a flat "not allowed" that reads as a permanent denial.
      orgLookupFailed = true
    }
  }
  return { allowed: false, orgLookupFailed }
}

export function authController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  // Route registrations grouped into cohesive registrars (OAuth, credential login, account
  // recovery, session) purely so no single function exceeds the size budget; each registers
  // onto the shared `app` and depends only on the module-level helpers above.
  registerOAuthRoutes(app)
  // Enterprise SSO lives in its own registrar: its round-trip carries PKCE + OIDC nonce secrets
  // that must stay out of the URL, so it owns a different state mechanism (a signed httpOnly
  // cookie) than the two consumer-OAuth legs above, while sharing their signer and redirect
  // allow-list through `loginFlow.ts`.
  registerSsoRoutes(app)
  registerCredentialRoutes(app)
  registerMachineNodeRoutes(app)
  registerAccountRecoveryRoutes(app)
  registerSessionRoutes(app)
  return app
}

function registerOAuthRoutes(app: Hono<AppEnv>): void {
  // Lets the SPA decide which login controls to show, and (local mode only) surface a
  // setup banner when the GitHub PAT is missing.
  buildHonoRoute(app, authConfigContract, (c) => {
    const cfg = authConfig(c)
    const container = c.get('container')
    const { localMode, infrastructure } = container.config
    // On a hosted facade (no `localMode`), advertise the source-control providers a user may
    // sign in with by pasting their OWN PAT — so the login screen offers a PAT option alongside
    // OAuth/password. Local mode keeps its richer `localMode.patLogin` (server-configured
    // one-click tokens), so don't duplicate it there.
    const patProviders =
      !localMode && container.vcsIdentity
        ? (Object.keys(container.vcsIdentity) as (keyof typeof container.vcsIdentity)[])
        : []
    return c.json(
      {
        enabled: cfg.enabled,
        providers: {
          github: cfg.githubEnabled,
          password: cfg.passwordEnabled,
          google: !!cfg.google,
          sso: !!cfg.sso,
        },
        // The operator's own button wording travels beside the boolean, because it names THEIR
        // identity provider and so is the one part of the login screen the SPA cannot localize.
        ...(cfg.sso ? { sso: { label: cfg.sso.label, protocol: 'oidc' as const } } : {}),
        ...(localMode ? { localMode } : {}),
        ...(patProviders.length > 0 ? { patLogin: { providers: patProviders } } : {}),
        // Test-only: advertise that the deployment runs with no auth, so the SPA renders the
        // board anonymously rather than gating to login. Only ever true under `TESTING_NO_AUTH`.
        ...(cfg.testingNoAuth ? { testingNoAuth: true } : {}),
        ...(infrastructure ? { infrastructure } : {}),
      },
      200,
    )
  })

  // ---- GitHub OAuth -------------------------------------------------------

  buildHonoRoute(app, githubLoginContract, async (c) => {
    const cfg = authConfig(c)
    if (!cfg.githubEnabled) return unavailable()
    const signedState = await beginRoundTrip(c, cfg)
    const url = githubClient(cfg).authorizeUrl({
      redirectUri: githubCallbackUrl(c, cfg),
      state: signedState,
      scope: cfg.allowedOrgs.length > 0 ? 'read:user read:org' : 'read:user',
    })
    return c.redirect(url)
  })

  buildHonoRoute(app, githubCallbackContract, async (c) => {
    const cfg = authConfig(c)
    if (!cfg.githubEnabled) return unavailable()
    const state = await consumeState(c, cfg)
    const code = c.req.query('code')
    if (!code || !state) {
      return c.json({ error: { code: 'validation', message: 'Invalid OAuth callback' } }, 400)
    }
    const oauth = githubClient(cfg)
    const accessToken = await oauth.exchangeCode(code, githubCallbackUrl(c, cfg))
    const identity = await oauth.fetchUser(accessToken)

    const container = c.get('container')
    // An invite (matching this user's email) OR the allowlist admits the user. The
    // invite short-circuits the org allowlist, so it is bound to the invited email —
    // a leaked link can't admit an arbitrary GitHub account onto a private deployment.
    const invited = state.invite ? await peekInvite(c, state.invite) : null
    const inviteAdmits = invited != null && emailMatchesInvite(identity.email, invited.email)
    if (!inviteAdmits && !(await isGitHubSignInAllowed(oauth, accessToken, identity, cfg))) {
      return c.json(
        { error: { code: 'forbidden', message: `@${identity.login} is not allowed to sign in` } },
        403,
      )
    }
    const user = await container.userService.findOrCreateByIdentity('github', String(identity.id), {
      name: identity.name,
      email: identity.email,
      // GitHub only exposes an email it has verified for the account, so it is trusted
      // to link this login onto an existing same-email user.
      emailVerified: !!identity.email,
      avatarUrl: identity.avatarUrl,
      metadata: { login: identity.login },
    })
    await container.accountService.ensurePersonalAccount({
      id: user.id,
      login: identity.login,
      name: user.name,
    })
    if (state.invite) await acceptInvite(c, state.invite, user.id, user.email)
    const { token } = await mintSession(
      cfg,
      sessionUser(user, identity.login),
      await sessionGenerationFor(c, user.id),
    )
    return c.redirect(withToken(state.redirect, token))
  })

  // ---- Google OAuth -------------------------------------------------------

  buildHonoRoute(app, googleLoginContract, async (c) => {
    const cfg = authConfig(c)
    const google = requireGoogle(cfg)
    const signedState = await beginRoundTrip(c, cfg)
    return c.redirect(
      google.authorizeUrl({ redirectUri: googleCallbackUrl(c, cfg), state: signedState }),
    )
  })

  buildHonoRoute(app, googleCallbackContract, async (c) => {
    const cfg = authConfig(c)
    const google = requireGoogle(cfg)
    const state = await consumeState(c, cfg)
    const code = c.req.query('code')
    if (!code || !state) {
      return c.json({ error: { code: 'validation', message: 'Invalid OAuth callback' } }, 400)
    }
    const accessToken = await google.exchangeCode(code, googleCallbackUrl(c, cfg))
    const identity = await google.fetchUser(accessToken)
    const container = c.get('container')

    const existing = await container.userService.findByIdentity('google', identity.subject)
    // Gate NEW-user creation: an invite (matching the verified email) OR an allowlisted
    // VERIFIED email domain. An unverified Google email is never trusted to self-signup.
    const invited = state.invite ? await peekInvite(c, state.invite) : null
    const verifiedEmail = identity.emailVerified ? identity.email : null
    const inviteAdmits = invited != null && emailMatchesInvite(verifiedEmail, invited.email)
    if (!existing) {
      const allowed =
        inviteAdmits || (verifiedEmail ? emailDomainAllowed(verifiedEmail, cfg) : false)
      if (!allowed) {
        return c.json(
          { error: { code: 'forbidden', message: 'Sign-up requires an invitation' } },
          403,
        )
      }
    }
    const user = await container.userService.findOrCreateByIdentity('google', identity.subject, {
      name: identity.name,
      email: identity.email,
      emailVerified: identity.emailVerified,
      avatarUrl: identity.avatarUrl,
      metadata: { email: identity.email },
    })
    await container.accountService.ensurePersonalAccount({
      id: user.id,
      login: identity.email || user.id,
      name: user.name,
    })
    if (state.invite) await acceptInvite(c, state.invite, user.id, user.email)
    const { token } = await mintSession(
      cfg,
      sessionUser(user, identity.email || user.id),
      await sessionGenerationFor(c, user.id),
    )
    return c.redirect(withToken(state.redirect, token))
  })
}

function registerCredentialRoutes(app: Hono<AppEnv>): void {
  // ---- Email / password ---------------------------------------------------

  buildHonoRoute(app, signupContract, async (c) => {
    const cfg = authConfig(c)
    if (!cfg.passwordEnabled) return unavailable()
    const body = c.req.valid('json')
    if (await passwordAttemptLimited(c, body.email)) return tooManyAttempts()
    const container = c.get('container')

    // New-user creation is gated: an invite addressed to this email OR an allowlisted
    // email domain. The invite is bound to its email so a leaked link can't be used to
    // self-register an arbitrary address on a private deployment.
    const invited = body.invite ? await peekInvite(c, body.invite) : null
    const allowed =
      cfg.openSignup ||
      (invited != null && emailMatchesInvite(body.email, invited.email)) ||
      emailDomainAllowed(body.email, cfg)
    if (!allowed) {
      return c.json(
        { error: { code: 'forbidden', message: 'Sign-up requires an invitation' } },
        403,
      )
    }
    // A `ConflictError` (email already registered) / `ValidationError` (password policy)
    // from the service propagates to the shared handler UNTOUCHED. It used to be caught and
    // flattened onto a 400 `validation` envelope, which discarded each error's own code AND
    // its `details.reason` — the machine fact a client needs to tell "that email is taken"
    // from "that password is too weak". The handler maps them to 409 / 422 with the reason
    // intact. (Contrast the reset-password handler below, whose flattening is deliberate:
    // there the distinct causes are an ORACLE for whether a token exists.)
    const user = await container.userService.signupWithPassword({
      email: body.email,
      password: body.password,
      name: body.name,
    })
    await container.accountService.ensurePersonalAccount({
      id: user.id,
      login: user.email || user.id,
      name: user.name,
    })
    if (body.invite) await acceptInvite(c, body.invite, user.id, user.email)
    const { token } = await mintSession(
      cfg,
      sessionUser(user, user.email || user.id),
      await sessionGenerationFor(c, user.id),
    )
    return c.json({ token, user: sessionUser(user, user.email || user.id) }, 201)
  })

  buildHonoRoute(app, passwordLoginContract, async (c) => {
    const cfg = authConfig(c)
    if (!cfg.passwordEnabled) return unavailable()
    const body = c.req.valid('json')
    if (await passwordAttemptLimited(c, body.email)) return tooManyAttempts()
    const user = await c.get('container').userService.verifyPassword(body)
    if (!user) {
      throw new UnauthorizedError('Invalid email or password')
    }
    const { token } = await mintSession(
      cfg,
      sessionUser(user, user.email || user.id),
      await sessionGenerationFor(c, user.id),
    )
    return c.json({ token, user: sessionUser(user, user.email || user.id) }, 200)
  })

  // ---- Source-control PAT login -------------------------------------------

  // Log in as the account a GitHub/GitLab PAT belongs to. Served wherever the facade wired
  // identity resolvers: local mode AND both hosted facades (Node + Cloudflare) register the
  // registry (GitHub always, GitLab when a GitLab connection is configured), so a GitLab user
  // can sign in to a hosted deployment too — not only via OAuth. Only a facade that wires none
  // 503s. `token` omitted ⇒ use the deployment's configured PAT (local-mode one-click); present
  // ⇒ the user pasted their own (the hosted path, held to the login/org/domain allowlist). The
  // resolved provider id is the SAME `(provider, subject)` key OAuth uses, so a PAT login and a
  // GitHub OAuth login for the same person are one user.
  buildHonoRoute(app, patLoginContract, async (c) => {
    const cfg = authConfig(c)
    const container = c.get('container')
    const registry = requireCapability(container.vcsIdentity, 'Authentication is not configured')
    const { provider, token } = c.req.valid('json')
    const entry = registry[provider]
    if (!entry) {
      throw new UnavailableError(`${provider} sign-in is not available`)
    }
    const pat = token ?? entry.configuredToken?.()
    if (!pat) {
      // Local mode can be handed a token right here (it becomes the deployment's own credential),
      // so ask for one rather than for an env var the developer would have to restart to apply;
      // a hosted (multi-user) deployment has no deployment token at all — each user pastes their
      // OWN PAT, so the same instruction serves both.
      return c.json(
        {
          error: {
            code: 'validation',
            message: `Paste your ${provider === 'gitlab' ? 'GitLab' : 'GitHub'} personal access token to sign in.`,
          },
        },
        400,
      )
    }
    let identity
    try {
      identity = await entry.resolver.resolveIdentity(pat)
    } catch {
      throw new UnauthorizedError(`That ${provider} token is invalid or lacks the required access.`)
    }
    // Hosted facades (remote node) have no anonymous tier, so a PAT login is held to the same
    // login/org/domain allowlist as OAuth — a valid token alone must not admit an arbitrary
    // account. Local mode (a single developer's own machine) is exempt and signs in any valid
    // token, as before.
    if (!container.config.localMode) {
      const gate = await isPatIdentityAllowed(cfg, entry.resolver, identity, pat)
      if (!gate.allowed) {
        // When admission would only have come from group/org membership but enumerating it
        // failed (the common cause: the token can authenticate `/user` but lacks the broader
        // org/group-read scope), say so — otherwise a scope problem looks like a hard denial.
        const scopeHint = gate.orgLookupFailed
          ? ` If you belong to an allowed ${provider === 'gitlab' ? 'group' : 'organization'}, make sure the token grants ${provider === 'gitlab' ? 'the read_api scope' : 'the read:org scope'}.`
          : ''
        return c.json(
          {
            error: {
              code: 'forbidden',
              message: `@${identity.login} is not allowed to sign in.${scopeHint}`,
            },
          },
          403,
        )
      }
    }
    // Local mode's ONE token is both the identity above and the credential every agent step
    // clones, pushes, gates and merges with, so a token pasted into a deployment that holds none
    // is installed as that credential here — before the session is minted, so a failure to store
    // it is reported instead of handing the user a session into a product that cannot reach any
    // repo. Only ever a token the caller supplied (never the deployment's own, re-installed), and
    // only while `installable` says the environment names none; the facade's `install` refuses
    // otherwise, which the shared error handler renders as the refusal it is.
    if (token && container.localVcsSetup?.installable().includes(provider)) {
      await container.localVcsSetup.install(provider, token, { login: identity.login })
    }
    const user = await container.userService.findOrCreateByIdentity(provider, identity.externalId, {
      name: identity.name,
      email: identity.email,
      // The PAT proves control of the account, so its email is trusted to link onto an
      // existing same-email user (parity with the OAuth path).
      emailVerified: !!identity.email,
      avatarUrl: identity.avatarUrl,
      metadata: { login: identity.login },
    })
    await container.accountService.ensurePersonalAccount({
      id: user.id,
      login: identity.login,
      name: user.name,
    })
    const session = sessionUser(user, identity.login)
    const { token: sessionToken } = await mintSession(
      cfg,
      session,
      await sessionGenerationFor(c, user.id),
    )
    return c.json({ token: sessionToken, user: session }, 200)
  })
}

// The machine-token surface (mothership mode): the mint that turns a session into an
// account-scoped machine credential, plus the roster endpoints that make its nodes
// visible and revocable (SEC-5). Its own registrar so no single registrar outgrows the
// function budget.
function registerMachineNodeRoutes(app: Hono<AppEnv>): void {
  // ---- Machine-token minting (mothership mode) ----------------------------

  // Exchange the caller's mothership SESSION for a `machine`-audience token scoped to the
  // user's accounts, which a mothership-mode local node caches and presents on every
  // `/internal/persistence` call. This is a privilege boundary: a session becomes an
  // account-scoped machine credential, so the scope is derived ONLY from what the user
  // actually owns (`accountService.listForUser`), and `requestedAccountIds` may only NARROW
  // that set (intersection), never widen it. Served by any facade acting as a mothership
  // (its repository registry attached); 503 otherwise.
  buildHonoRoute(app, mintMachineTokenContract, async (c) => {
    const cfg = authConfig(c)
    const container = c.get('container')
    if (!container.repositories) {
      throw new UnavailableError('This deployment is not a mothership')
    }
    // Verify the presented bearer as a SESSION token (pinned `aud: session`), NOT via the
    // authGate — `/internal`-style machine calls bypass that gate, and pinning the audience
    // stops a container/ws/machine token from being replayed to mint a fresh machine token.
    // `verifySession` is the one place that check lives, so this endpoint can't drift from it.
    const session = await verifySession(c)
    if (!session) {
      return c.json(
        { error: { code: 'forbidden', message: 'A valid session is required to mint a token' } },
        403,
      )
    }
    const body = c.req.valid('json')
    const accounts = await container.accountService.listForUser({
      id: session.id,
      login: session.login,
      name: session.name,
    })
    let accountIds = accounts.map((a) => a.id)
    if (body.requestedAccountIds) {
      const owned = new Set(accountIds)
      accountIds = body.requestedAccountIds.filter((id) => owned.has(id))
    }
    // Fail closed: a node with no in-scope account can do nothing useful and must not be handed
    // a token (e.g. a `requestedAccountIds` naming only accounts the user does not own).
    if (accountIds.length === 0) {
      return c.json(
        { error: { code: 'forbidden', message: 'No accounts in scope for this user' } },
        403,
      )
    }
    // The machine-node roster (SEC-5) must be able to record this mint, or the token must not
    // exist: an unrecorded token is an unrevocable one. A deployment acting as a mothership
    // (it serves `/internal/*` and thus has `repositories`) with no roster wired would mint
    // exactly that, so refuse rather than silently skipping the roster.
    const machineNodes = container.machineNodeRepository
    if (!machineNodes && container.repositories) {
      throw new UnavailableError(
        'Machine nodes cannot be recorded on this deployment',
        'machine_roster_unavailable',
      )
    }
    // The mint helper computes and signs the authoritative `exp`/`nodeId`, then hands them back
    // so the response echoes EXACTLY what was signed (no second clock read that could drift).
    const { token, exp, nodeId } = await mintMachineToken(cfg.sessionSecret, {
      userId: session.id,
      accountIds,
      nodeId: body.nodeId,
      ttlMs: cfg.machineTokenTtlMs,
    })
    // Fold the mint into the roster BEFORE handing out the token: the roster is what makes the
    // node revocable, so a token the roster never saw must not leave the building.
    //
    // The write itself enforces ownership, so a REVOKED node id can never be re-minted
    // (revocation is permanent per node id; reconnecting mints a fresh one) and a node id
    // another user holds cannot be taken over. Doing that here rather than in a preceding
    // `get` closes the race where two first mints of one id both read "unknown" and the loser
    // overwrote the winner's scope. One 403 for both causes, so a node id is not an existence
    // oracle. The token was signed above but never leaves this function.
    if (machineNodes) {
      const outcome = await machineNodes.recordMint({
        nodeId,
        userId: session.id,
        accountIds,
        mintedAt: Date.now(),
        expiresAt: exp,
      })
      if (outcome === 'refused') {
        throw new ForbiddenError('This node id is not available', {
          reason: 'machine_node_unavailable',
        })
      }
    }
    return c.json(
      {
        token,
        exp,
        nodeId,
        userId: session.id,
        accountIds,
        // Echo the verified user so a mothership-mode node can mint its own local session for
        // the same person after connecting.
        user: {
          id: session.id,
          login: session.login,
          name: session.name,
          avatarUrl: session.avatarUrl,
          email: session.email ?? null,
        },
      },
      200,
    )
  })

  // ---- Machine-node roster: list + revoke (SEC-5) --------------------------

  // The mint above records every node against its user; these two are how that user sees
  // and kills their nodes. Revocation writes a tombstone every `/internal/*` machine gate
  // consults (`verifyMachineRequest`), so a leaked machine token stops working everywhere
  // at once instead of staying valid for its full TTL.
  buildHonoRoute(app, listMachineNodesContract, async (c) => {
    // Authenticate BEFORE probing the capability, so an unauthenticated caller cannot learn
    // whether this deployment records machine nodes (the ordering every other machine surface
    // documents as load-bearing).
    const session = await verifySession(c)
    if (!session) throw new UnauthorizedError('A valid session is required')
    const nodes = requireCapability(
      c.get('container').machineNodeRepository,
      'Machine nodes are not recorded on this deployment',
    )
    const rows = await nodes.listByUser(session.id)
    return c.json(
      {
        nodes: rows.map((row) => ({
          nodeId: row.nodeId,
          accountIds: row.accountIds,
          createdAt: row.createdAt,
          lastMintedAt: row.lastMintedAt,
          exp: row.expiresAt,
          revokedAt: row.revokedAt,
        })),
      },
      200,
    )
  })

  buildHonoRoute(app, revokeMachineNodeContract, async (c) => {
    // Authenticate first, for the same non-oracle reason as the list route above.
    const session = await verifySession(c)
    if (!session) throw new UnauthorizedError('A valid session is required')
    const nodes = requireCapability(
      c.get('container').machineNodeRepository,
      'Machine nodes are not recorded on this deployment',
    )
    const { nodeId } = c.req.valid('param')
    const row = await nodes.get(nodeId)
    // Owner-scoped, with the auth gate's existence-non-leak policy: an unknown node and
    // another user's node are the same 404.
    if (!row || row.userId !== session.id) throw new NotFoundError('Machine node', nodeId)
    await nodes.revoke(nodeId, Date.now(), session.id)
    return c.body(null, 204)
  })
}

function registerAccountRecoveryRoutes(app: Hono<AppEnv>): void {
  // ---- Forgot / reset password --------------------------------------------

  // Request a reset link. ALWAYS returns 204 (whether or not the email is registered)
  // so the endpoint can't be used to enumerate accounts; the service emails the link
  // (or logs it when no system sender is configured) and never returns the raw token.
  buildHonoRoute(app, forgotPasswordContract, async (c) => {
    const cfg = authConfig(c)
    if (!cfg.passwordEnabled) return unavailable()
    const body = c.req.valid('json')
    if (await passwordAttemptLimited(c, body.email)) return tooManyAttempts()
    try {
      await c.get('container').passwordReset?.request(body.email)
    } catch {
      // Swallow: the response must be identical (204) for a registered and an
      // unregistered email, so a failure on the registered-only path (a token write, etc.)
      // can't become an account-enumeration oracle. The service logs internally.
    }
    return c.body(null, 204)
  })

  // Redeem a reset token + set a new password. A missing / used / expired token maps to
  // a generic 400 (never distinguishing the cases). Throttled per client IP under a
  // fixed shared bucket (see the comment at the call site below).
  buildHonoRoute(app, resetPasswordContract, async (c) => {
    const cfg = authConfig(c)
    const passwordReset = c.get('container').passwordReset
    if (!cfg.passwordEnabled || !passwordReset) return unavailable()
    const body = c.req.valid('json')
    // Throttle per client IP, NOT per token: a brute-force attacker uses a fresh token
    // each guess, so keying on the token value would hand every guess its own bucket and
    // limit nothing. (Per-IP can't lock out a "victim" here — redeem is token-, not
    // email-, addressed.)
    if (await passwordAttemptLimited(c, 'reset-password')) return tooManyAttempts()
    try {
      await passwordReset.reset(body.token, body.password)
      return c.body(null, 204)
    } catch (err) {
      if (
        err instanceof NotFoundError ||
        err instanceof ConflictError ||
        err instanceof ValidationError
      ) {
        return c.json(
          {
            error: {
              code: 'validation',
              message: 'This password reset link is invalid or has expired.',
            },
          },
          400,
        )
      }
      throw err
    }
  })

  // ---- Invitations (peek + accept) ----------------------------------------

  // Public peek so the SPA can show the org name on the accept screen.
  buildHonoRoute(app, peekInvitationContract, async (c) => {
    const container = c.get('container')
    if (!container.invitations) return c.json({ valid: false } as const, 200)
    const record = await container.invitations.peek(c.req.valid('param').token)
    if (!record) return c.json({ valid: false } as const, 200)
    const account = await container.accountService.get(record.accountId)
    return c.json(
      { valid: true as const, email: record.email, accountName: account?.name ?? null },
      200,
    )
  })

  // Accept an invitation as the signed-in user (the SPA calls this after login).
  buildHonoRoute(app, acceptInvitationContract, async (c) => {
    const user = await verifySession(c)
    if (!user) {
      throw new UnauthorizedError('Sign in to accept')
    }
    const container = c.get('container')
    if (!container.invitations) {
      throw new UnavailableError('Invitations not configured')
    }
    try {
      const accountId = await container.invitations.accept(
        c.req.valid('param').token,
        user.id,
        user.email ?? null,
      )
      return c.json({ accountId }, 200)
    } catch (err) {
      if (err instanceof ConflictError) {
        return c.json({ error: { code: 'conflict', message: err.message } }, 409)
      }
      if (err instanceof NotFoundError) {
        return c.json({ error: { code: 'not_found', message: 'Invitation not found' } }, 404)
      }
      throw err
    }
  })
}

function registerSessionRoutes(app: Hono<AppEnv>): void {
  // Who am I? Used by the SPA to validate a stored token on boot. A valid session resolves
  // even when auth is otherwise "disabled" (a local PAT/password session under devOpen);
  // only an absent/invalid token on a disabled deployment reports the anonymous state.
  buildHonoRoute(app, meContract, async (c) => {
    const user = await verifySession(c)
    if (!user) {
      if (!authConfig(c).enabled) return c.json({ user: null, enabled: false }, 200)
      throw new UnauthorizedError('Not authenticated')
    }
    return c.json(
      {
        user: {
          id: user.id,
          login: user.login,
          name: user.name,
          avatarUrl: user.avatarUrl,
          email: user.email ?? null,
        },
        enabled: authConfig(c).enabled,
      },
      200,
    )
  })

  // Logout is a client-side token drop: it ends THIS browser's session by forgetting the token,
  // which is all a single sign-out needs and costs no write. Ending sessions the caller cannot
  // reach is `revokeMySessionsContract` below.
  buildHonoRoute(app, logoutContract, (c) => c.body(null, 204))

  // "Sign out everywhere": advance the caller's own session generation, which invalidates every
  // token minted for them — including the one that made this request, which is the point rather
  // than an oversight (somebody reaching for this has usually lost a device and cannot say which
  // session to keep). A replacement token is minted from the NEW generation and returned, so the
  // browser that asked stays signed in without a trip back through the identity provider.
  buildHonoRoute(app, revokeMySessionsContract, async (c) => {
    const user = requireUser(c, 'Sign in to manage your sessions')
    const generation = await c.get('container').userService.revokeSessions(user.id)
    // Deliberately NOT audited. The account audit log records what an account ADMIN is
    // answerable for, and this is a person acting on their own sessions: there is no account it
    // belongs to (a user may be in several, or none but their own), and filing it under a guess
    // would be exactly the misattribution the log's actor model exists to prevent.
    const { token, exp } = await mintSession(
      authConfig(c),
      { id: user.id, login: user.login, name: user.name, avatarUrl: user.avatarUrl },
      generation,
    )
    return c.json({ token, exp }, 200)
  })
}
