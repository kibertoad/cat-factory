import type {
  Clock,
  Logger,
  McpOAuthConfig,
  McpOAuthGrantRecord,
  McpOAuthGrantRepository,
  McpOAuthTokenResult,
  SecretCipher,
} from '@cat-factory/kernel'
import { bytesToBase64Url } from '../shared/base64.js'
import {
  getErrorMessage,
  MCP_OAUTH_DEFAULT_HEADER,
  MCP_OAUTH_DEFAULT_HEADER_TEMPLATE,
  noopLogger,
  ValidationError,
} from '@cat-factory/kernel'
import type { ToolServerOAuthStatus } from '@cat-factory/contracts'
import {
  type McpOAuthEndpoints,
  McpOAuthError,
  type McpOAuthFetch,
  type McpOAuthTokens,
  assertAllowedOAuthUrl,
  buildAuthorizationUrl,
  discoverMcpOAuthEndpoints,
  exchangeAuthorizationCode,
  refreshAccessToken,
  requestClientCredentialsToken,
} from './mcpOAuthClient.js'

/**
 * HKDF domain tag separating this store's ciphertexts from every other cipher in the platform.
 * ONE tag covers both things sealed here (the stored token set and the in-flight authorization
 * request), which is why each carries an explicit `kind` claim that the opener pins — the same
 * discipline the token signer applies with its `aud`, so a value minted for one purpose can never
 * be opened as the other.
 */
export const MCP_OAUTH_CIPHER_INFO = 'cat-factory:mcp-oauth'

/**
 * How long an in-flight authorization request stays valid. Long enough to sign in to a vendor and
 * approve a consent screen, short enough that an abandoned one is not a lasting artefact.
 */
const AUTHORIZATION_REQUEST_TTL_MS = 10 * 60 * 1000

/**
 * How far before its stated expiry an access token is treated as spent.
 *
 * A dispatched token is used by an agent in a container for the length of a run, not at the
 * instant it is handed over, so "expires in 20 seconds" is functionally expired. Refreshing early
 * costs one round trip; handing over a token that dies mid-run costs the agent its tool with no
 * unavailability reason to state, because the platform believed it was wired.
 */
const EXPIRY_SKEW_MS = 60_000

/** How many times a lost refresh race re-reads before giving up. */
const MAX_REFRESH_ATTEMPTS = 3

/** The sealed token set, as it sits at rest. */
interface StoredTokens {
  kind: 'tokens'
  accessToken: string
  refreshToken?: string
  /** Absolute expiry (epoch ms), when the authorization server stated one. */
  expiresAt?: number
  scope?: string
}

/**
 * An in-flight authorization request, sealed into the `state` parameter the vendor hands back.
 *
 * STATELESS on purpose, and the choice is worth the paragraph. The obvious shape is a pending-row
 * table, and it costs a table, a migration on both runtimes, a repository pair, and a sweeper on
 * both facades to delete the rows for every consent screen anyone ever abandoned. Sealing the
 * request into the state parameter instead makes every one of those disappear: the value is
 * confidential and authenticated (AEAD under the deployment's own key), it carries its own expiry,
 * and an abandoned request is garbage-collected by the operator closing the tab.
 *
 * What the seal has to carry is what a callback cannot re-derive or must not trust:
 *
 * - `codeVerifier` — PKCE's whole point is that it never leaves the client, so it is sealed rather
 *   than merely signed. The platform's own `StateSigner` is HMAC over a READABLE payload, which is
 *   right for a nonce and wrong for this.
 * - `userId` — the callback is a browser navigation the vendor triggers, so without binding it to
 *   the person who STARTED the flow, an attacker who gets an admin to open their authorization
 *   link plants their own vendor account as the board's connection.
 * - `tokenUrl` / `resource` / `redirectUri` — pinned at start, so the exchange happens against the
 *   endpoint discovery named at the moment the operator consented rather than whatever a metadata
 *   document says a few minutes later.
 */
export interface McpAuthorizationRequest {
  kind: 'authorization-request'
  workspaceId: string
  serverId: string
  userId: string | null
  codeVerifier: string
  redirectUri: string
  tokenUrl: string
  useBasicAuth: boolean
  resource: string
  exp: number
}

/** The non-secret summary persisted beside the sealed tokens (the shape the API renders). */
type GrantSummary = Omit<ToolServerOAuthStatus, 'grant' | 'connected'>

export interface McpOAuthServiceDependencies {
  mcpOAuthGrantRepository: McpOAuthGrantRepository
  /** Seals both the stored tokens and the in-flight request (tag {@link MCP_OAUTH_CIPHER_INFO}). */
  secretCipher: SecretCipher
  clock: Clock
  /** Injected for tests; production passes nothing and the global `fetch` is used. */
  fetchImpl?: typeof fetch
  logger?: Logger
}

/**
 * Owns a workspace's OAuth grants against remote (`http`) MCP tool servers: starting a grant,
 * completing one, minting and refreshing access tokens for a dispatch, and reporting what a board
 * is connected to.
 *
 * The split from `CapabilityCredentialsService` beside it is the split between a credential a
 * human TYPES and one a human GRANTS. A typed credential is inert until a dispatch reads it; a
 * granted one expires, refreshes, gets revoked at the vendor, and belongs to a named person's
 * account. That is why this is a service of its own rather than another key in the checklist: the
 * checklist's whole shape (a key, a write-only value, a last-written date) cannot express any of it.
 *
 * STRICTLY the store plus the protocol. What a deployment DECLARES is registry state, and the
 * caller passes the declaration in — this package has no business reaching into the agent-kind
 * registry, exactly as the credential service has none.
 *
 * CONCURRENCY: the refresh path is the contended one, and it is contended by two dispatches rather
 * than two humans. It rides a rev-guarded `compareAndSwap`, and the loser does NOT re-apply its own
 * write (the rule every other rev-guarded path in this repo follows) — it re-reads and adopts the
 * winner's tokens. Re-applying would be actively wrong here: an authorization server that rotates
 * refresh tokens has already invalidated the loser's, so re-applying replaces a working grant with
 * a dead one.
 */
export class McpOAuthService {
  private readonly log: Logger

  constructor(private readonly deps: McpOAuthServiceDependencies) {
    this.log = deps.logger ?? noopLogger
  }

  private get fetchDeps(): McpOAuthFetch {
    return this.deps.fetchImpl ? { fetch: this.deps.fetchImpl } : {}
  }

  /**
   * Begin an `authorization_code` grant: resolve the endpoints, mint a PKCE pair, and return the
   * vendor URL to send the operator to.
   *
   * Throws rather than returning a status, because every failure here is a REFUSAL an operator
   * asked for directly (a declaration that cannot be granted, a deployment with no redirect URL,
   * an authorization server that publishes nothing) and the surface that called it is a button
   * press, not a run.
   */
  async startAuthorization(input: {
    workspaceId: string
    serverId: string
    serverUrl: string
    oauth: McpOAuthConfig
    userId: string | null
    redirectUri: string
  }): Promise<{ url: string }> {
    if (input.oauth.grant !== 'authorization_code') {
      throw new ValidationError(
        `Tool server '${input.serverId}' authenticates with the client-credentials grant, which ` +
          `needs no authorization: its token is minted from the deployment's own client on the ` +
          `first dispatch that needs one.`,
        { reason: 'oauth_grant_not_interactive' },
      )
    }
    const endpoints = await this.resolveEndpoints(input.serverUrl, input.oauth)
    const codeVerifier = randomCodeVerifier()
    const request: McpAuthorizationRequest = {
      kind: 'authorization-request',
      workspaceId: input.workspaceId,
      serverId: input.serverId,
      userId: input.userId,
      codeVerifier,
      redirectUri: input.redirectUri,
      tokenUrl: endpoints.tokenUrl,
      useBasicAuth: endpoints.useBasicAuth,
      resource: input.oauth.resource ?? input.serverUrl,
      exp: this.deps.clock.now() + AUTHORIZATION_REQUEST_TTL_MS,
    }
    return {
      url: buildAuthorizationUrl({
        authorizationUrl: endpoints.authorizationUrl,
        clientId: input.oauth.clientId,
        redirectUri: input.redirectUri,
        state: await this.deps.secretCipher.encrypt(JSON.stringify(request)),
        codeChallenge: await codeChallengeFor(codeVerifier),
        ...(input.oauth.scopes?.length ? { scopes: input.oauth.scopes } : {}),
        resource: request.resource,
      }),
    }
  }

  /**
   * Open the sealed `state` a callback carried, or null when it is absent, forged, expired or not
   * an authorization request at all.
   *
   * Null rather than a thrown cause on purpose: the four are indistinguishable to the caller and
   * every one of them is a 401, so telling them apart would only tell an attacker which of their
   * guesses was closer.
   */
  async readAuthorizationRequest(state: string | null): Promise<McpAuthorizationRequest | null> {
    if (!state) return null
    let parsed: unknown
    try {
      parsed = JSON.parse(await this.deps.secretCipher.decrypt(state))
    } catch {
      // silent-catch-ok: a state that will not open is a 401 whatever the reason, and the reason is
      // attacker-supplied. The caller logs the refusal with the request's own correlation id.
      return null
    }
    const request = parsed as McpAuthorizationRequest
    if (!request || request.kind !== 'authorization-request') return null
    if (typeof request.exp !== 'number' || request.exp < this.deps.clock.now()) return null
    return request
  }

  /**
   * Complete a grant: exchange the code for tokens and seal them for the workspace.
   *
   * A BLIND upsert, unlike the refresh path: a human just authorised, and what they authorised
   * supersedes whatever the row held — including a grant a colleague made a minute earlier, which
   * is exactly the "reconnect with a different account" case a rev guard would turn into a
   * spurious conflict.
   */
  async completeAuthorization(
    request: McpAuthorizationRequest,
    input: { code: string; clientId: string; clientSecret?: string },
  ): Promise<void> {
    const tokens = await exchangeAuthorizationCode(
      {
        tokenUrl: request.tokenUrl,
        clientId: input.clientId,
        ...(input.clientSecret ? { clientSecret: input.clientSecret } : {}),
        useBasicAuth: request.useBasicAuth,
        resource: request.resource,
        code: input.code,
        redirectUri: request.redirectUri,
        codeVerifier: request.codeVerifier,
      },
      this.fetchDeps,
    ).catch((error: unknown) => {
      throw asRefusal(error)
    })
    const now = this.deps.clock.now()
    await this.deps.mcpOAuthGrantRepository.upsert(
      await this.buildRecord({
        workspaceId: request.workspaceId,
        serverId: request.serverId,
        tokens,
        now,
        rev: 0,
        createdAt: now,
        summary: {
          connectedAt: now,
          ...(request.userId ? { connectedBy: request.userId } : {}),
        },
      }),
    )
    this.log.info('mcp tool server oauth grant stored', {
      workspaceId: request.workspaceId,
      toolServerId: request.serverId,
      refreshable: Boolean(tokens.refreshToken),
    })
  }

  /** Drop a workspace's grant for one server. Idempotent: a missing row is already disconnected. */
  async disconnect(workspaceId: string, serverId: string): Promise<void> {
    await this.deps.mcpOAuthGrantRepository.delete(workspaceId, serverId)
  }

  /**
   * The non-secret connection state of every grant a workspace holds, keyed by server id.
   *
   * ONE read for the whole inventory rather than a lookup per declared server: the operator surface
   * renders a row per DECLARATION, and the declarations are the deployment's whole registry.
   */
  async listStatuses(workspaceId: string): Promise<Map<string, GrantSummary>> {
    const records = await this.deps.mcpOAuthGrantRepository.listByWorkspace(workspaceId)
    return new Map(records.map((record) => [record.serverId, parseSummary(record)]))
  }

  /**
   * The access token one dispatch needs, refreshing or minting it when what is stored will not do.
   *
   * Never throws: a dispatch asking for a tool is not a place to fail a run, so every failure comes
   * back as a `token_failed` result the caller states to the agent. That is the same disposition
   * `resolveToolServers` gives an unresolved static credential, and for the same reason.
   */
  async accessToken(input: {
    workspaceId: string
    serverId: string
    serverUrl: string
    oauth: McpOAuthConfig
    /** The resolved client secret, when the declaration named a key for one. */
    clientSecret?: string
  }): Promise<McpOAuthTokenResult> {
    try {
      const token = await this.resolveToken(input)
      return token
        ? {
            status: 'ok',
            header: input.oauth.header ?? MCP_OAUTH_DEFAULT_HEADER,
            value: (input.oauth.headerTemplate ?? MCP_OAUTH_DEFAULT_HEADER_TEMPLATE).replaceAll(
              '{value}',
              token,
            ),
          }
        : { status: 'not_connected' }
    } catch (error) {
      const message = describeOAuthError(error)
      this.log.warn('mcp tool server oauth token could not be obtained', {
        workspaceId: input.workspaceId,
        toolServerId: input.serverId,
        detail: message,
      })
      await this.recordFailure(input.workspaceId, input.serverId, message)
      return { status: 'token_failed', error: message }
    }
  }

  /** The raw access token, or null when nothing is granted. Throws on a real failure. */
  private async resolveToken(input: {
    workspaceId: string
    serverId: string
    serverUrl: string
    oauth: McpOAuthConfig
    clientSecret?: string
  }): Promise<string | null> {
    for (let attempt = 0; attempt < MAX_REFRESH_ATTEMPTS; attempt++) {
      const record = await this.deps.mcpOAuthGrantRepository.get(input.workspaceId, input.serverId)
      const stored = record ? await this.openTokens(record) : null
      if (stored && !this.isSpent(stored)) {
        // A live token also settles any failure the summary still claims: `lastError` is written by
        // whichever dispatch could not mint one, and nothing else would ever take it back off a
        // connection that started working again. Only touches the row when there is something to
        // clear, so the ordinary dispatch stays a single read.
        if (record && parseSummary(record).lastError !== undefined) await this.clearFailure(record)
        return stored.accessToken
      }

      if (input.oauth.grant === 'authorization_code' && !stored) return null
      if (input.oauth.grant === 'authorization_code' && !stored?.refreshToken) {
        throw new McpOAuthError(
          `The stored access token has expired and the authorization server issued no refresh ` +
            `token, so the connection has to be granted again.`,
          true,
        )
      }
      let tokens: McpOAuthTokens
      try {
        tokens = await this.mintTokens(input, stored?.refreshToken)
      } catch (error) {
        // The refresh race the rev guard below CANNOT settle, and the likelier half of it against a
        // rotating authorization server. Two dispatches find the same token spent and POST the same
        // refresh token; the winner's exchange rotates it, which INVALIDATES the loser's copy, so
        // the loser fails right here with `invalid_grant` and never reaches the compareAndSwap that
        // would have told it it lost. Re-reading is what tells the two apart: a row that has moved
        // on to a live token means a peer succeeded, and this dispatch wants a token rather than a
        // diagnosis. With nothing new stored, the failure is real and propagates untouched.
        const adopted = await this.adoptConcurrentToken(input.workspaceId, input.serverId, record)
        if (adopted) {
          this.log.info('adopted a concurrently refreshed mcp oauth token after a lost race', {
            workspaceId: input.workspaceId,
            toolServerId: input.serverId,
          })
          return adopted
        }
        throw error
      }

      const now = this.deps.clock.now()
      const swapped = await this.deps.mcpOAuthGrantRepository.compareAndSwap(
        await this.buildRecord({
          workspaceId: input.workspaceId,
          serverId: input.serverId,
          tokens: {
            ...tokens,
            // An authorization server that rotates refresh tokens returns a new one; one that does
            // not returns none, and DROPPING the old one there would turn a working grant into a
            // single-use one. Carrying it forward is what makes both behaviours refreshable.
            ...(tokens.refreshToken ? {} : { refreshToken: stored?.refreshToken }),
          },
          now,
          rev: (record?.rev ?? -1) + 1,
          createdAt: record?.createdAt ?? now,
          summary: {
            ...(record ? dropError(parseSummary(record)) : {}),
            ...(record ? {} : { connectedAt: now }),
          },
        }),
        record?.rev ?? null,
      )
      // Lost the race: another dispatch refreshed first. Loop back and read THEIR tokens rather
      // than re-applying ours — a rotated refresh token makes ours the stale set, so re-applying
      // would replace a working grant with a dead one.
      if (swapped) return tokens.accessToken
    }
    throw new McpOAuthError(
      `The stored grant is being refreshed by several runs at once and this dispatch could not ` +
        `settle on a token; retry.`,
      false,
    )
  }

  /**
   * One exchange at the token endpoint: the machine grant mints from the deployment's own client,
   * the interactive one spends the stored refresh token.
   *
   * Split out of {@link resolveToken} so that method reads as what it is (the read, the spend
   * check, the race handling and the swap) rather than carrying the wire shape of two requests
   * through the middle of it.
   */
  private async mintTokens(
    input: {
      serverUrl: string
      oauth: McpOAuthConfig
      clientSecret?: string
    },
    refreshToken: string | undefined,
  ): Promise<McpOAuthTokens> {
    const endpoints = await this.resolveEndpoints(input.serverUrl, input.oauth)
    const common = {
      tokenUrl: endpoints.tokenUrl,
      clientId: input.oauth.clientId,
      ...(input.clientSecret ? { clientSecret: input.clientSecret } : {}),
      useBasicAuth: endpoints.useBasicAuth,
      resource: input.oauth.resource ?? input.serverUrl,
    }
    const scopes = input.oauth.scopes?.length ? { scopes: input.oauth.scopes } : {}
    return input.oauth.grant === 'client_credentials'
      ? requestClientCredentialsToken({ ...common, ...scopes }, this.fetchDeps)
      : // Reached only past the guards above, which return or throw when there is no refresh token.
        refreshAccessToken({ ...common, refreshToken: refreshToken! }, this.fetchDeps)
  }

  /**
   * The token a CONCURRENT dispatch stored while this one was failing to mint its own, or null.
   *
   * Best effort by construction: it runs on a path that already has a real error to report, so
   * anything that goes wrong here (an unreadable row, a rotated key) means only that there is
   * nothing to adopt, and the caller rethrows the failure that brought it here. Requires the row to
   * have MOVED: an unchanged `rev` is the same grant this attempt already read and failed with,
   * and returning its expired token would hand the run a credential the vendor has finished with.
   */
  private async adoptConcurrentToken(
    workspaceId: string,
    serverId: string,
    seen: McpOAuthGrantRecord | null,
  ): Promise<string | null> {
    try {
      const record = await this.deps.mcpOAuthGrantRepository.get(workspaceId, serverId)
      if (!record || record.rev === seen?.rev) return null
      const stored = await this.openTokens(record)
      return stored && !this.isSpent(stored) ? stored.accessToken : null
    } catch {
      // silent-catch-ok: this is a recovery read behind an error that is about to propagate, and
      // its own failure is not a second thing to report: it only means nothing could be adopted.
      return null
    }
  }

  /** Endpoints: the declaration's, when it pinned them, else discovered from the server url. */
  private async resolveEndpoints(
    serverUrl: string,
    oauth: McpOAuthConfig,
  ): Promise<McpOAuthEndpoints> {
    if (oauth.authorizationUrl && oauth.tokenUrl) {
      // The SAME floor a discovered endpoint and every redirect hop is held to, from the one
      // implementation: a rule enforced on two of three paths is not a rule.
      assertAllowedOAuthUrl(oauth.authorizationUrl, 'declared OAuth authorizationUrl')
      assertAllowedOAuthUrl(oauth.tokenUrl, 'declared OAuth tokenUrl')
      return {
        authorizationUrl: oauth.authorizationUrl,
        tokenUrl: oauth.tokenUrl,
        useBasicAuth: false,
      }
    }
    const discovered = await discoverMcpOAuthEndpoints(serverUrl, this.fetchDeps)
    // A HALF-declared pair still overrides its half: pinning one endpoint and discovering the other
    // is a legitimate declaration (a vendor whose metadata is right about one and stale about the
    // other), and silently ignoring the pin would send tokens somewhere the operator refused.
    return {
      authorizationUrl: oauth.authorizationUrl ?? discovered.authorizationUrl,
      tokenUrl: oauth.tokenUrl ?? discovered.tokenUrl,
      useBasicAuth: discovered.useBasicAuth,
    }
  }

  /** Whether a stored access token is too close to its expiry to hand to a run. */
  private isSpent(tokens: StoredTokens): boolean {
    return (
      tokens.expiresAt !== undefined && tokens.expiresAt - EXPIRY_SKEW_MS <= this.deps.clock.now()
    )
  }

  private async openTokens(record: McpOAuthGrantRecord): Promise<StoredTokens | null> {
    try {
      const parsed = JSON.parse(await this.deps.secretCipher.decrypt(record.tokens)) as StoredTokens
      return parsed?.kind === 'tokens' && typeof parsed.accessToken === 'string' ? parsed : null
    } catch (error) {
      // A row that will not open is a rotated ENCRYPTION_KEY or a corrupt blob, and it is
      // permanent: nothing this process does will decrypt it, so it must read as a broken
      // connection to be re-granted rather than as an absent one that a dispatch quietly retries.
      throw new McpOAuthError(
        `The stored grant could not be opened (${describeOAuthError(error)}). It was sealed with a ` +
          `different encryption key; disconnect and grant it again.`,
        true,
      )
    }
  }

  private async buildRecord(input: {
    workspaceId: string
    serverId: string
    tokens: McpOAuthTokens & { refreshToken?: string | undefined }
    now: number
    rev: number
    createdAt: number
    summary: GrantSummary
  }): Promise<McpOAuthGrantRecord> {
    const expiresAt =
      input.tokens.expiresIn !== undefined ? input.now + input.tokens.expiresIn * 1000 : undefined
    const stored: StoredTokens = {
      kind: 'tokens',
      accessToken: input.tokens.accessToken,
      ...(input.tokens.refreshToken ? { refreshToken: input.tokens.refreshToken } : {}),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      ...(input.tokens.scope ? { scope: input.tokens.scope } : {}),
    }
    const summary: GrantSummary = {
      ...input.summary,
      ...(input.tokens.scope ? { scopes: input.tokens.scope.split(/\s+/).filter(Boolean) } : {}),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      refreshable: Boolean(stored.refreshToken),
    }
    return {
      workspaceId: input.workspaceId,
      serverId: input.serverId,
      tokens: await this.deps.secretCipher.encrypt(JSON.stringify(stored)),
      summary: JSON.stringify(summary),
      rev: input.rev,
      createdAt: input.createdAt,
      updatedAt: input.now,
    }
  }

  /**
   * Record on the SUMMARY that the last token exchange failed, so the operator surface can say a
   * connection stopped working without anyone reading a run's prompt.
   *
   * Best effort by construction, and it only ever touches a row that already exists: a failure with
   * nothing stored is `not_connected`, which the surface already states. The rev guard is NOT
   * retried on a lost swap: the note is advisory, and losing it to a concurrent refresh that
   * SUCCEEDED is the correct outcome rather than a lost write.
   */
  private async recordFailure(
    workspaceId: string,
    serverId: string,
    message: string,
  ): Promise<void> {
    const record = await this.deps.mcpOAuthGrantRepository.get(workspaceId, serverId)
    if (!record) return
    await this.writeSummary(record, { ...parseSummary(record), lastError: message })
  }

  /**
   * Take a recorded failure back off a connection that has started working again.
   *
   * The other half of {@link recordFailure}, and the surface reads wrong without it: `lastError`
   * describes the last exchange that failed, so on a token that is merely CACHED (the common
   * dispatch, which mints nothing) nothing would ever clear it, and one transient vendor outage
   * would leave a red "the last token renewal failed" banner on a working grant until the access
   * token happened to expire. Same advisory, same unretried rev guard.
   */
  private async clearFailure(record: McpOAuthGrantRecord): Promise<void> {
    await this.writeSummary(record, dropError(parseSummary(record)))
  }

  /** One rev-guarded, unretried write of the non-secret half. */
  private async writeSummary(record: McpOAuthGrantRecord, summary: GrantSummary): Promise<void> {
    await this.deps.mcpOAuthGrantRepository.compareAndSwap(
      {
        ...record,
        summary: JSON.stringify(summary),
        rev: record.rev + 1,
        updatedAt: this.deps.clock.now(),
      },
      record.rev,
    )
  }
}

/** Parse the persisted non-secret summary, tolerating a corrupt row (the view still loads). */
function parseSummary(record: McpOAuthGrantRecord): GrantSummary {
  try {
    const parsed = JSON.parse(record.summary) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as GrantSummary) : {}
  } catch {
    // silent-catch-ok: a summary is a display projection of a row whose SEALED half is the truth,
    // so a drifted one must never keep an operator from seeing that the grant exists.
    return {}
  }
}

/** The summary with any recorded failure cleared — what a successful exchange leaves behind. */
function dropError(summary: GrantSummary): GrantSummary {
  const { lastError: _dropped, ...rest } = summary
  return rest
}

/**
 * An OAuth failure as an operator-facing sentence.
 *
 * Thin over `getErrorMessage` on purpose, and kept as a named function because an
 * `McpOAuthError`'s message IS the operator-facing sentence: wrapping it in a generic description
 * would bury the one part of it that names the fix. The scrubbing and the length cap belong to the
 * shared describer, so a second `redactSecrets` here would only re-scan text already scrubbed and
 * risk re-matching the `[REDACTED]` marker it left behind.
 */
function describeOAuthError(error: unknown): string {
  return getErrorMessage(error)
}

/**
 * An OAuth failure as an HTTP refusal, for the INTERACTIVE paths (starting and completing a grant),
 * where the caller is a person and a thrown cause is the answer they asked for.
 *
 * A PERMANENT failure becomes a 422 carrying `details.reason`, because what must change is the
 * declaration or the grant and the operator is the one who can change it. A TRANSIENT one is
 * rethrown untouched and surfaces as a 500, which is the honest status for "the vendor's
 * authorization server did not answer": mapping it to a 4xx would tell the operator to fix
 * something that is not theirs.
 */
function asRefusal(error: unknown): unknown {
  if (error instanceof McpOAuthError && error.permanent) {
    return new ValidationError(describeOAuthError(error), { reason: 'oauth_exchange_refused' })
  }
  return error
}

/** A PKCE code verifier: 32 random bytes, base64url — the RFC 7636 recommended shape. */
function randomCodeVerifier(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return bytesToBase64Url(bytes)
}

/** The S256 challenge for a verifier. */
async function codeChallengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return bytesToBase64Url(new Uint8Array(digest))
}
