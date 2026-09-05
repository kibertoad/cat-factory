import type { Clock, Logger, SecretCipher } from '@cat-factory/kernel'
import { bytesToBase64Url } from '../shared/base64.js'
import { ConflictError, noopLogger } from '@cat-factory/kernel'
import { PUBLIC_API_SCOPES, type PublicApiScope } from '@cat-factory/contracts'
import { scopeSatisfies, type PublicApiKeyService } from '../publicApi/PublicApiKeyService.js'

// ---------------------------------------------------------------------------
// The SERVING half of MCP authorization: this deployment acting as the authorization server for
// its own hosted MCP endpoint, so a host (claude.ai, an IDE, a hosted agent) connects by pressing
// a button and approving a consent screen instead of being handed a key to paste into a config
// file that then sits on disk in plaintext forever.
//
// The counterpart of `McpOAuthService` next door, pointed the other way: that one is this platform
// as an OAuth CLIENT of a vendor's MCP server, this one is a vendor's host as an OAuth client of
// OURS. They share no code because they share no problem: a client discovers endpoints, keeps a
// refresh token and mints for a dispatch, while a server registers clients, renders consent and
// issues.
// What they do share is the file's central trick, and its justification is the same as the one
// recorded for the in-flight authorization request there: EVERY piece of state this flow needs
// between two requests is SEALED into the value the other party carries, so the whole authorization
// server costs no table, no migration on either runtime, and no sweeper for the rows behind every
// consent screen anyone ever abandoned.
//
// There are three such values, each sealed under the deployment's own key with an explicit `kind`
// the opener pins (one HKDF tag covers all three, so the claim is what keeps a value minted for one
// purpose from being opened as another):
//
//   - the CLIENT ID a dynamic registration answers with, carrying the client's name and its
//     registered redirect URIs;
//   - the AUTHORIZATION REQUEST the consent screen is opened on, carrying the client, the redirect
//     URI already validated against that registration, and the PKCE challenge;
//   - the CODE the browser carries back to the host, carrying everything above plus what the human
//     actually approved (which board, which scope) and who approved it.
//
// What the flow finally ISSUES is an ordinary public-API key. That is the whole reason this fits in
// one file: the credential a host ends up with is the same credential the surface already
// authenticates, so nothing downstream of the token endpoint learns a second token format, the key
// panel lists an OAuth-connected host beside every other integration, and REVOKING one is the
// button that is already there. What it costs is an access token that does not expire, which is
// why no refresh grant is advertised: `metadataDocuments.ts` states that where a client reads it.
// ---------------------------------------------------------------------------

/**
 * HKDF domain tag separating this server's ciphertexts from every other cipher in the platform,
 * the consuming side's included: a `state` minted for a vendor grant must not open as a client
 * registration here, and it cannot, because the two derive different keys from the same master.
 */
export const MCP_AUTH_SERVER_CIPHER_INFO = 'cat-factory:mcp-authorization-server'

/**
 * How long an in-flight authorization request stays valid: the window between a host opening the
 * authorization URL and a human finishing with the consent screen. Long enough to sign in first,
 * short enough that an abandoned tab is not a lasting artefact.
 */
const AUTHORIZATION_REQUEST_TTL_MS = 15 * 60 * 1000

/**
 * How long an issued authorization code stays redeemable. Deliberately far shorter than the
 * request above: the code is redeemed by a machine, in one round trip, immediately.
 *
 * It is also the whole of the code's replay defence, and the trade is worth stating rather than
 * implying. With no row there is no single-use enforcement, so a code presented twice inside this
 * window is exchanged twice. What stops that being a way IN is PKCE: redeeming needs the verifier,
 * which never left the host, so a code captured from browser history, a referrer or a proxy log is
 * unredeemable by whoever captured it. What is left is a legitimate host redeeming its own code
 * twice and getting two keys of the scope its user already approved, which is untidy rather than
 * dangerous, and visible in the key panel either way.
 */
const AUTHORIZATION_CODE_TTL_MS = 60 * 1000

/** The PKCE method the MCP authorization spec requires. Plain is refused, not tolerated. */
const REQUIRED_CODE_CHALLENGE_METHOD = 'S256'

/** Registered redirect URIs one client may declare, and the longest name it may register. */
const MAX_REDIRECT_URIS = 8
const MAX_CLIENT_NAME_LENGTH = 120

/**
 * The scope the consent screen offers before anyone has chosen: the middle of the ladder, which is
 * what an MCP host is actually for (read the board, author and start work on it) and stops short of
 * both rungs that answer a parked run or merge a pull request.
 */
export const CONSENT_DEFAULT_SCOPE: PublicApiScope = 'write'

/** A registration, sealed into the `client_id` a dynamic registration answers with. */
interface SealedClient {
  kind: 'mcp-client'
  name: string
  redirectUris: string[]
  issuedAt: number
}

/** An authorization request, sealed into the value the consent screen is opened on. */
export interface McpAuthorizationRequestState {
  kind: 'mcp-authorization-request'
  clientId: string
  clientName: string
  redirectUri: string
  codeChallenge: string
  /** The host's own `state`, echoed back untouched on the redirect. Absent when it sent none. */
  state?: string
  /** The scope the host ASKED for, which the consent screen offers as its default. */
  requestedScope?: PublicApiScope
  exp: number
}

/** An issued code, sealed into the `code` the browser carries back to the host. */
interface SealedCode {
  kind: 'mcp-authorization-code'
  clientId: string
  clientName: string
  redirectUri: string
  codeChallenge: string
  accountId: string
  workspaceId: string
  scope: PublicApiScope
  approvedByUserId: string | null
  exp: number
}

/** What a dynamic client registration answers with (RFC 7591 §3.2.1). */
export interface McpClientRegistration {
  clientId: string
  clientName: string
  redirectUris: string[]
  issuedAt: number
}

/** What the consent screen needs to describe the party asking, before anyone approves it. */
export interface McpAuthorizationRequestSummary {
  clientName: string
  /** The origin the browser will be sent back to: the fact a human can actually judge. */
  redirectOrigin: string
  /**
   * What the screen preselects: the platform's default, or the host's ask when that asks for LESS
   * ({@link consentDefaultScope}). Never what an unauthenticated registration asked for above it.
   */
  defaultScope: PublicApiScope
  /** What the host asked for, verbatim, so the screen can say so when it exceeds the default. */
  requestedScope?: PublicApiScope
}

/** An issued access token, in the shape the token endpoint answers with. */
export interface McpIssuedToken {
  accessToken: string
  scope: PublicApiScope
  /** The key row behind the token, so the caller can log WHAT it issued without the secret. */
  keyId: string
}

export interface McpAuthorizationServerDependencies {
  /** Seals all three carried values (tag {@link MCP_AUTH_SERVER_CIPHER_INFO}). */
  secretCipher: SecretCipher
  /** What the flow finally issues: an ordinary inbound public-API key. */
  publicApiKeys: PublicApiKeyService
  clock: Clock
  logger?: Logger
}

/**
 * A refusal the OAuth wire has its own vocabulary for.
 *
 * OAuth's error codes are not this platform's `DomainError` codes and cannot be mapped onto them
 * without losing the half a client acts on: `invalid_grant` and `invalid_client` are both 400 to a
 * conforming authorization server, and both would be a bare `validation` here. So the protocol's
 * own code is carried, and the controller renders the protocol's own body shape (RFC 6749 §5.2)
 * rather than the deployment's error envelope, the same split the hosted MCP endpoint already
 * makes between an HTTP-level auth failure and a JSON-RPC method refusal.
 */
export type McpOAuthErrorCode =
  | 'invalid_request'
  | 'invalid_client'
  | 'invalid_grant'
  | 'unauthorized_client'
  | 'unsupported_grant_type'
  // RFC 6749 §4.1.2.1's own, for the authorization endpoint: a client that asked for a response
  // type this server does not serve is told which half of its request was wrong, where the
  // generic code sends its author reading the whole query string.
  | 'unsupported_response_type'
  | 'invalid_scope'
  | 'access_denied'
  // RFC 7591 §3.2.2's own two, which the registration endpoint answers with. Kept as members
  // rather than folded into `invalid_request`: a client that registered a redirect URI this
  // server will not send a code to has one line to change, and the generic code sends its
  // author looking through the whole request body for it.
  | 'invalid_redirect_uri'
  | 'invalid_client_metadata'

export class McpOAuthProtocolError extends Error {
  constructor(
    readonly oauthError: McpOAuthErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'McpOAuthProtocolError'
  }
}

/**
 * A refusal at the authorization endpoint that the CLIENT must be told about, on the redirect URI
 * it registered (RFC 6749 §4.1.2.1).
 *
 * The distinction this type carries is the whole of that section's rule, and it is a distinction
 * only this service can make. Where the request cannot be ATTRIBUTED to a registered redirect
 * target (an unknown `client_id`, a `redirect_uri` the client never registered), the refusal has
 * nowhere safe to go: bouncing it back would turn this deployment's own origin into a forwarder to
 * any address an attacker names, which is the open redirect the registration check exists to
 * prevent. Those stay a plain {@link McpOAuthProtocolError} and are rendered as a page.
 *
 * Once the redirect URI HAS been matched against the registration, the opposite is true: a bad
 * `response_type`, a missing PKCE challenge or a `resource` naming someone else are faults in the
 * host's own request, and it is the host that must hear about them. Rendered as a page instead,
 * they leave a conforming client waiting on a callback that never arrives until it times out, and
 * the fault it then reports is "this deployment did not answer" rather than the one line it got
 * wrong.
 */
export class McpOAuthRedirectableError extends McpOAuthProtocolError {
  constructor(
    oauthError: McpOAuthErrorCode,
    message: string,
    /** The already-validated address to report this on, and the host's `state` to echo. */
    readonly target: McpOAuthRedirectTarget,
  ) {
    super(oauthError, message)
    this.name = 'McpOAuthRedirectableError'
  }
}

/** A registered redirect URI plus the host's own `state`: where a refusal or a code is delivered. */
export interface McpOAuthRedirectTarget {
  redirectUri: string
  state?: string
}

/**
 * Where a refusal the client must hear about goes.
 *
 * Exported as a function over the error rather than a method, because the target rides the error
 * itself: the controller catching it needs no access to the server that threw it, and there is no
 * way to spell "report this somewhere the request was not validated against".
 */
export function mcpOAuthErrorRedirect(error: McpOAuthRedirectableError): string {
  return redirectWithError(error.target, error.oauthError, error.message)
}

/**
 * This deployment as the authorization server for its own hosted MCP endpoint.
 *
 * Stateless by construction (see the file header): every method turns one carried value into the
 * next, and the only thing that outlives the flow is the key the token endpoint mints, a row that
 * already existed as a concept, listed and revocable where an operator already looks.
 */
export class McpAuthorizationServer {
  private readonly log: Logger

  constructor(private readonly deps: McpAuthorizationServerDependencies) {
    this.log = deps.logger ?? noopLogger
  }

  /**
   * Register a client dynamically (RFC 7591), answering with a `client_id` that IS its own
   * registration record.
   *
   * Dynamic registration is what makes this reachable from a host nobody configured: claude.ai and
   * the IDE clients register themselves on first connect and have no console at this deployment to
   * be registered in by hand. The consuming half of this initiative deliberately does NOT perform
   * registration against a vendor, and the asymmetry is not an inconsistency: there, a client
   * minted at runtime would be deployment state with no operator-visible identity at the vendor,
   * nobody able to find, rotate or revoke it. Here the registration confers NOTHING on its own
   * (no scope, no board, no token, not even the ability to ask again) until a signed-in human with
   * `secrets.manage` approves a specific board and scope on the consent screen. What that human
   * approves is a key they can see and revoke, so the registration is a name and a redirect list,
   * and sealing it into the identifier makes it exactly as revocable as it is powerful.
   *
   * Only PUBLIC clients are registered (no secret is issued), which is what the MCP hosts are:
   * a native app or a browser-side host cannot keep one, and PKCE is what actually binds the
   * exchange to the party that started it.
   */
  async registerClient(input: {
    clientName?: string
    redirectUris: unknown
  }): Promise<McpClientRegistration> {
    const redirectUris = normaliseRedirectUris(input.redirectUris)
    const clientName = normaliseClientName(input.clientName)
    const issuedAt = this.deps.clock.now()
    const client: SealedClient = { kind: 'mcp-client', name: clientName, redirectUris, issuedAt }
    const clientId = await this.deps.secretCipher.encrypt(JSON.stringify(client))
    this.log.info('mcp authorization server registered a client', {
      clientName,
      redirectOrigins: redirectUris.map(originOf),
    })
    return { clientId, clientName, redirectUris, issuedAt }
  }

  /**
   * Validate an authorization request and seal it for the consent screen.
   *
   * Everything a later step must not re-derive from attacker-supplied input is pinned here: the
   * redirect URI is checked against the registration NOW, so nothing downstream has to trust the
   * one the browser carries, and the PKCE challenge is captured before any human sees the screen.
   *
   * The refusals are split by WHO can be told. A request whose `redirect_uri` is not registered
   * cannot be reported by redirecting to it (that is the open-redirect this check exists to
   * prevent), so it throws and the controller renders it as a page. Everything else is a fault the
   * client should hear about on its own redirect, and the controller sends it there.
   */
  async beginAuthorization(input: {
    clientId: string
    redirectUri: string
    responseType: string
    codeChallenge: string
    codeChallengeMethod: string
    state?: string
    scope?: string
    /** RFC 8707, required by the MCP spec: the resource the host means to reach. */
    resource?: string
    /** This deployment's own resource identifier, to hold `resource` to. */
    expectedResource: string
  }): Promise<{ sealedRequest: string; summary: McpAuthorizationRequestSummary }> {
    const client = await this.openClient(input.clientId)
    if (!client.redirectUris.includes(input.redirectUri)) {
      throw new McpOAuthProtocolError(
        'invalid_request',
        'redirect_uri does not match any URI this client registered.',
      )
    }
    // Past this line the address is one the client itself registered, so every further refusal is
    // REPORTABLE to it rather than only to the human standing in front of the browser.
    const target: McpOAuthRedirectTarget = {
      redirectUri: input.redirectUri,
      ...(input.state ? { state: input.state } : {}),
    }
    if (input.responseType !== 'code') {
      throw new McpOAuthRedirectableError(
        'unsupported_response_type',
        `Only the authorization-code response type is served; got '${input.responseType}'.`,
        target,
      )
    }
    if (input.codeChallengeMethod !== REQUIRED_CODE_CHALLENGE_METHOD || !input.codeChallenge) {
      throw new McpOAuthRedirectableError(
        'invalid_request',
        `This authorization server requires PKCE with code_challenge_method=${REQUIRED_CODE_CHALLENGE_METHOD}.`,
        target,
      )
    }
    // RFC 8707. Checked rather than ignored because the whole point of the parameter is that a
    // token is minted FOR one resource: accepting a request that names someone else's would let a
    // host believe it holds a token this deployment vouched for against a surface it does not
    // serve. Absent is tolerated (a client one revision behind), a MISMATCH never is.
    if (input.resource && !resourceMatches(input.resource, input.expectedResource)) {
      throw new McpOAuthRedirectableError(
        'invalid_request',
        `This authorization server issues tokens for ${input.expectedResource}, not ${input.resource}.`,
        target,
      )
    }
    const requestedScope = readScope(input.scope)
    const request: McpAuthorizationRequestState = {
      kind: 'mcp-authorization-request',
      clientId: input.clientId,
      clientName: client.name,
      redirectUri: input.redirectUri,
      codeChallenge: input.codeChallenge,
      ...(input.state ? { state: input.state } : {}),
      ...(requestedScope ? { requestedScope } : {}),
      exp: this.deps.clock.now() + AUTHORIZATION_REQUEST_TTL_MS,
    }
    return {
      sealedRequest: await this.deps.secretCipher.encrypt(JSON.stringify(request)),
      summary: summarise(request),
    }
  }

  /**
   * Open a sealed authorization request, or `null` when it is absent, forged, expired or not an
   * authorization request at all.
   *
   * Null rather than a cause, for the reason the consuming side records about its own state: the
   * four are indistinguishable to the caller, every one of them refuses the same way, and telling
   * them apart tells whoever is guessing which guess was closer.
   */
  async readAuthorizationRequest(
    sealed: string | null,
  ): Promise<McpAuthorizationRequestState | null> {
    if (!sealed) return null
    const request = await this.open<McpAuthorizationRequestState>(
      sealed,
      'mcp-authorization-request',
    )
    if (!request) return null
    return request.exp >= this.deps.clock.now() ? request : null
  }

  /** What the consent screen renders about the party asking. */
  describeRequest(request: McpAuthorizationRequestState): McpAuthorizationRequestSummary {
    return summarise(request)
  }

  /**
   * Turn an approved request into the redirect the browser follows back to the host.
   *
   * The APPROVAL is the caller's to establish, not this service's: who is signed in, and whether
   * they still hold `secrets.manage` on the board they picked, is resolved at the controller
   * through the one shared workspace-access resolution, the same division the consuming side's
   * completion makes, and for the same reason (the board is a value inside the flow rather than a
   * segment in the path, so no gate can bind it).
   */
  async approve(
    request: McpAuthorizationRequestState,
    approval: {
      accountId: string
      workspaceId: string
      scope: PublicApiScope
      approvedByUserId: string | null
    },
  ): Promise<{ redirectTo: string }> {
    const code: SealedCode = {
      kind: 'mcp-authorization-code',
      clientId: request.clientId,
      clientName: request.clientName,
      redirectUri: request.redirectUri,
      codeChallenge: request.codeChallenge,
      accountId: approval.accountId,
      workspaceId: approval.workspaceId,
      scope: approval.scope,
      approvedByUserId: approval.approvedByUserId,
      exp: this.deps.clock.now() + AUTHORIZATION_CODE_TTL_MS,
    }
    const url = new URL(request.redirectUri)
    url.searchParams.set('code', await this.deps.secretCipher.encrypt(JSON.stringify(code)))
    if (request.state) url.searchParams.set('state', request.state)
    return { redirectTo: url.toString() }
  }

  /**
   * The redirect that reports a REFUSAL to the host (RFC 6749 §4.1.2.1).
   *
   * A denial is an answer, not a dead end: a host left waiting on a tab the human closed reports a
   * timeout, which sends its user looking for a fault in the deployment instead of at the choice
   * they just made.
   */
  denial(request: McpAuthorizationRequestState): { redirectTo: string } {
    return {
      redirectTo: redirectWithError(
        { redirectUri: request.redirectUri, ...(request.state ? { state: request.state } : {}) },
        'access_denied',
        'The request was declined.',
      ),
    }
  }

  /**
   * Redeem a code for an access token: the one call a host makes on its own, with no browser.
   *
   * PKCE is verified here and it is the only thing that binds this exchange to the host that
   * started the flow, since a public client presents no secret. The redirect URI and client id are
   * checked against the code as well: belt and braces on the same binding, and the check RFC 6749
   * §4.1.3 asks for.
   */
  async redeemCode(input: {
    code: string
    clientId: string
    redirectUri?: string
    codeVerifier: string
  }): Promise<McpIssuedToken> {
    const code = await this.open<SealedCode>(input.code, 'mcp-authorization-code')
    if (!code) {
      throw new McpOAuthProtocolError(
        'invalid_grant',
        'This authorization code is invalid or has expired.',
      )
    }
    if (code.exp < this.deps.clock.now()) {
      throw new McpOAuthProtocolError('invalid_grant', 'This authorization code has expired.')
    }
    if (code.clientId !== input.clientId) {
      throw new McpOAuthProtocolError(
        'invalid_grant',
        'This authorization code was issued to a different client.',
      )
    }
    if (input.redirectUri && input.redirectUri !== code.redirectUri) {
      throw new McpOAuthProtocolError(
        'invalid_grant',
        'redirect_uri does not match the one this code was issued for.',
      )
    }
    if (!(await pkceMatches(input.codeVerifier, code.codeChallenge))) {
      throw new McpOAuthProtocolError('invalid_grant', 'The PKCE code verifier does not match.')
    }
    const issued = await this.issueKeyFor(code)
    this.log.info('mcp authorization server issued an access token', {
      workspaceId: code.workspaceId,
      keyId: issued.record.id,
      scope: code.scope,
      clientName: code.clientName,
    })
    return { accessToken: issued.secret, scope: code.scope, keyId: issued.record.id }
  }

  /**
   * Mint the key an approved code redeems for, answering a refusal in the protocol's vocabulary.
   *
   * The one refusal `issue` can raise that a host will actually meet is the per-board key cap, and
   * it arrives at the WORST moment in the flow: the human has already approved, the browser has
   * already gone back to the host, and what is left is a machine-to-machine call. Left to reach
   * `handleError`, that answers the deployment's own `{ error: { code, message } }` envelope with
   * a 409, which is not a shape any OAuth client parses: the host reports a broken connection and
   * names nothing a person could act on. Translated here, the same fact arrives as
   * `error_description`, which every host renders, naming the board's key panel and what to do
   * there. This is the one place a `DomainError` is deliberately re-mapped rather than rethrown,
   * for the reason the file header gives: this endpoint answers in OAuth's vocabulary, so an
   * envelope is the foreign shape here and the protocol code is the native one.
   */
  private async issueKeyFor(code: SealedCode) {
    try {
      return await this.deps.publicApiKeys.issue(
        {
          accountId: code.accountId,
          workspaceId: code.workspaceId,
          createdByUserId: code.approvedByUserId,
          // The connected host, on its own side. Opaque to the platform like every other external
          // identity, and what makes a run this host starts attributable to it rather than to the
          // person who happened to approve the connection months earlier.
          externalIdentity: externalIdentityFor(code.clientName),
        },
        keyLabelFor(code.clientName),
        code.scope,
      )
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error
      throw new McpOAuthProtocolError(
        'access_denied',
        `${error.message}. The connection was approved, but no key could be issued on that board: ` +
          'revoke one in the board settings and connect again.',
      )
    }
  }

  /** Open a sealed value and pin its `kind`, or null if it will not open as that kind. */
  private async open<T extends { kind: string }>(
    sealed: string,
    kind: T['kind'],
  ): Promise<T | null> {
    let parsed: unknown
    try {
      parsed = JSON.parse(await this.deps.secretCipher.decrypt(sealed))
    } catch {
      // silent-catch-ok: a value that will not open is refused whatever the reason, and the reason
      // is supplied by whoever presented it. The controller logs the refusal with its request id.
      return null
    }
    const value = parsed as T
    return value && value.kind === kind ? value : null
  }

  /** Open a `client_id`, refusing in the protocol's own vocabulary when it is not one of ours. */
  private async openClient(clientId: string): Promise<SealedClient> {
    const client = await this.open<SealedClient>(clientId, 'mcp-client')
    if (!client) {
      throw new McpOAuthProtocolError(
        'invalid_client',
        'This client_id was not issued by this deployment. Register the client first.',
      )
    }
    return client
  }
}

/** A refusal delivered where the protocol puts one: the client's own registered redirect URI. */
function redirectWithError(
  target: McpOAuthRedirectTarget,
  error: McpOAuthErrorCode,
  description: string,
): string {
  const url = new URL(target.redirectUri)
  url.searchParams.set('error', error)
  url.searchParams.set('error_description', description)
  if (target.state) url.searchParams.set('state', target.state)
  return url.toString()
}

/** The label an issued key carries in the panel, so a person can tell what to revoke. */
function keyLabelFor(clientName: string): string {
  return `MCP: ${clientName}`
}

/**
 * Who the issued key acts for, on the host's own side.
 *
 * Built here rather than at the call site because it is the ONE value in this flow that leaves it:
 * `externalIdentity` is echoed on the key resource, on run projections and on `GET /api/v1/me`, and
 * the name inside it is a stranger's free text. {@link normaliseClientName} is what holds it to the
 * same rule `publicApiExternalIdentitySchema` states on the wire, which this path does not cross.
 */
function externalIdentityFor(clientName: string): string {
  return `mcp-client:${clientName}`
}

/** The non-secret half of a request, for the consent screen. */
function summarise(request: McpAuthorizationRequestState): McpAuthorizationRequestSummary {
  return {
    clientName: request.clientName,
    redirectOrigin: originOf(request.redirectUri),
    defaultScope: consentDefaultScope(request.requestedScope),
    ...(request.requestedScope ? { requestedScope: request.requestedScope } : {}),
  }
}

/**
 * The scope the consent screen PRESELECTS, which is never a scope a stranger asked for above the
 * platform's own default.
 *
 * A registration is unauthenticated: anyone who can reach `/oauth/register` can name themselves and
 * then ask for `admin`. Letting that ASK become the preselected radio button would make the top of
 * the ladder the default on a screen whose whole subject is a grant, decided by the party asking
 * for it rather than the one granting it, and a person clicking Connect on what looks like the
 * shipped default would hand over the rung that can delete tasks and merge pull requests.
 *
 * So the ask is honoured only DOWNWARD. A host that wants less than the default gets less
 * preselected (nothing is protected by talking someone into granting `read`); a host that wants
 * more gets the default, and {@link McpAuthorizationRequestSummary.requestedScope} still carries
 * what it asked for, so the screen can say so and a human can raise it deliberately.
 */
function consentDefaultScope(requested: PublicApiScope | undefined): PublicApiScope {
  if (!requested) return CONSENT_DEFAULT_SCOPE
  return scopeSatisfies(requested, CONSENT_DEFAULT_SCOPE) ? CONSENT_DEFAULT_SCOPE : requested
}

/**
 * The redirect URIs a registration may carry.
 *
 * `https` anywhere, plus loopback `http` (RFC 8252 §7.3: a native host listens on 127.0.0.1 on a
 * port it picked at start-up, which is the shape every desktop MCP host uses) and the custom
 * schemes the same RFC gives native apps. A bare `http://` on any other host is refused: the
 * authorization code travels on that URL.
 */
function normaliseRedirectUris(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : []
  const uris = list.filter(
    (entry): entry is string => typeof entry === 'string' && entry.length > 0,
  )
  if (!uris.length) {
    throw new McpOAuthProtocolError(
      'invalid_client_metadata',
      'redirect_uris must name at least one URI this client will be redirected to.',
    )
  }
  if (uris.length > MAX_REDIRECT_URIS) {
    throw new McpOAuthProtocolError(
      'invalid_client_metadata',
      `A client may register at most ${MAX_REDIRECT_URIS} redirect URIs.`,
    )
  }
  for (const uri of uris) {
    if (!isAllowedRedirectUri(uri)) {
      throw new McpOAuthProtocolError(
        'invalid_redirect_uri',
        `${uri} is not a redirect URI this authorization server will send a code to. Use https, ` +
          'a loopback http address, or a private-use scheme.',
      )
    }
  }
  return uris
}

/** Whether a registered redirect URI is one this server will send an authorization code to. */
export function isAllowedRedirectUri(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    // silent-catch-ok: an unparseable value is refused by the caller with the message above, which
    // says more than a parse failure would.
    return false
  }
  // A fragment is where a redirect URI cannot carry one (RFC 6749 §3.1.2), and appending our query
  // to a URL that has one would put the code after the fragment, where it never reaches the host.
  if (url.hash) return false
  if (url.protocol === 'https:') return true
  if (url.protocol === 'http:') return isLoopbackHost(url.hostname)
  // A private-use scheme (`com.example.app:/callback`, `vscode://…`) is how a native host is
  // reached without a listening socket. There is no transport to hold to https, because there is
  // no transport: the OS hands the URL to whichever application claimed the scheme.
  //
  // Which is exactly why the test is what a scheme MEANS rather than a list of bad names. A scheme
  // the BROWSER interprets is not routed to an application at all, and this URL is navigated to
  // (`window.location.assign`) from the consent screen with an authorization code appended, so
  // `javascript:` there executes in the SPA's own document and `data:`/`blob:`/`file:` render
  // attacker-chosen content on it. Naming only `javascript:` reads as a fix and admits every
  // sibling; excluding the schemes with browser-defined meaning is the rule the RFC states
  // (a private-use scheme is by definition NOT a standard one) and covers the ones nobody
  // remembered.
  return (
    /^[a-z][a-z0-9+.-]*:$/i.test(url.protocol) &&
    !BROWSER_INTERPRETED_SCHEMES.has(url.protocol.toLowerCase())
  )
}

/**
 * Schemes a browser gives its own meaning to, which therefore cannot be a private-use scheme.
 *
 * The URL standard's "special" schemes minus the two handled above, plus the pseudo-schemes that
 * resolve inside the current document rather than dispatching to an application. Every member is
 * defined by a standard, so this set is closed by something other than the imagination of whoever
 * edits it next.
 */
const BROWSER_INTERPRETED_SCHEMES = new Set([
  // URL-standard special schemes (http/https answered above on their own terms).
  'ftp:',
  'file:',
  'ws:',
  'wss:',
  // Resolved by the browser in the current document's context, never dispatched to an app.
  'javascript:',
  'vbscript:',
  'data:',
  'blob:',
  'about:',
  'filesystem:',
  'view-source:',
])

/** Loopback, in both families plus the name, which is what a native host actually registers. */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '')
  return host === 'localhost' || host === '127.0.0.1' || host === '::1'
}

/**
 * A client name that is safe to render on a consent screen, in a key label, and in the
 * `externalIdentity` the name is spliced into.
 *
 * That last one is why the class here is not a matter of taste. `externalIdentity` normally arrives
 * over the wire, where `publicApiExternalIdentitySchema` refuses control characters AND the two
 * Unicode separators; a name registered here reaches `PublicApiKeyService.issue` directly, so this
 * function is the only thing standing where that schema stands. The separators matter for the same
 * reason the controls do: U+2028 and U+2029 are LINE BREAKS to every renderer that matters, so a
 * name carrying one breaks a line-oriented log or a table row on whichever surface echoes the value
 * next, and the schema's own doc records that they are refused rather than tolerated.
 */
function normaliseClientName(raw: string | undefined): string {
  // Stripped rather than refused: the name is a third party's free text on a screen whose whole job
  // is to say WHO is asking, and refusing the registration over a stray character would take that
  // screen away instead of cleaning it up.
  const cleaned = (raw ?? '').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').trim()
  if (!cleaned) return 'An unnamed MCP client'
  return cleaned.length > MAX_CLIENT_NAME_LENGTH
    ? `${cleaned.slice(0, MAX_CLIENT_NAME_LENGTH - 1)}…`
    : cleaned
}

/** The origin of a redirect URI, for a human to judge. Falls back to the raw value. */
function originOf(raw: string): string {
  try {
    const url = new URL(raw)
    return url.origin === 'null' ? `${url.protocol}//` : url.origin
  } catch {
    // silent-catch-ok: only reachable for a value that already passed registration, and showing it
    // verbatim is more use on a consent screen than showing nothing.
    return raw
  }
}

/**
 * The requested scope, when the host named one of ours.
 *
 * An unknown scope is DROPPED rather than refused, and the consent screen then offers its own
 * default. The scope a token carries is what a human picked on that screen, so a host asking for
 * something this deployment does not have is asking for a default it will be told about, not
 * making a claim that has to be adjudicated. A space-separated list takes the first member the
 * ladder knows, which is what a client sending `mcp read` means.
 */
function readScope(raw: string | undefined): PublicApiScope | undefined {
  for (const candidate of (raw ?? '').split(/\s+/)) {
    const match = PUBLIC_API_SCOPES.find((scope) => scope === candidate)
    if (match) return match
  }
  return undefined
}

/**
 * Whether an RFC 8707 `resource` names this deployment's MCP endpoint.
 *
 * Compared with a trailing slash tolerated on either side, because that is the one difference a
 * conforming client and a conforming server routinely disagree about, and refusing over it would
 * be this deployment failing a host for being right.
 */
function resourceMatches(presented: string, expected: string): boolean {
  const trim = (value: string) => value.replace(/\/+$/, '')
  return trim(presented) === trim(expected)
}

/** Whether a presented verifier hashes to the challenge the request was sealed with. */
async function pkceMatches(verifier: string, challenge: string): Promise<boolean> {
  if (!verifier) return false
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return bytesToBase64Url(new Uint8Array(digest)) === challenge
}
