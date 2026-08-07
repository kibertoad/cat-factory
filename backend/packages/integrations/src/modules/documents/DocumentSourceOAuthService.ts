import type {
  DocumentCredentials,
  DocumentSourceKind,
  DocumentSourceOAuthSpec,
  DocumentSourceRegistry,
  Clock,
  Logger,
} from '@cat-factory/kernel'
import {
  DOCUMENT_OAUTH_CREDENTIAL_KEYS,
  UnavailableError,
  ValidationError,
  describeError,
  noopLogger,
} from '@cat-factory/kernel'
import type { DocumentConnectionRecord } from '@cat-factory/kernel'

// DocumentSourceOAuthService: the ONE `authorization_code` flow every document source that
// declares an `oauth` half is connected through. A provider contributes four constants
// (`DocumentSourceOAuthSpec`) and nothing else — no fetch, no token parsing, no credential
// mapping — so the second source to gain OAuth adds a declaration rather than a second copy of
// this file. The credential bag it writes is the platform-owned one
// (`DOCUMENT_OAUTH_CREDENTIAL_KEYS`), which is what lets a provider stay ignorant of the whole
// lifecycle and simply notice a token in the bag it is handed.
//
// The split from `McpOAuthService` (the tool-server grants) is the split between what the grant
// AUTHORISES. That one seals its in-flight request into the `state` parameter because it must
// carry a PKCE verifier and a per-server resource; this one is a plain confidential-client web
// flow against a deployment-registered app, whose `state` is the platform's own HMAC nonce minted
// by the controller. Merging them would drag PKCE, endpoint discovery and a grant repository into
// a flow that has a fixed endpoint pair and stores its result as an ordinary connection.

/** The deployment's registered OAuth app for one source. */
export interface DocumentOAuthClient {
  clientId: string
  clientSecret: string
  /** The redirect the app is registered with; reused verbatim on the exchange. */
  redirectUrl: string
}

/**
 * How far before its stated expiry an access token is treated as spent.
 *
 * A resolved credential is used for the length of an import or a whole-file re-fetch, not at the
 * instant it is read, so "expires in twenty seconds" is functionally expired. Refreshing early
 * costs one round trip; handing over a token that dies mid-fetch costs the reader its document
 * and reports it as a source outage.
 */
const EXPIRY_SKEW_MS = 60_000

interface TokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  error?: string
  error_description?: string
  message?: string
}

export interface DocumentSourceOAuthServiceDependencies {
  registry: DocumentSourceRegistry
  /**
   * The deployment's registered app for a source, resolved per workspace (the account key its
   * workspace belongs to, so an org registers ONE app shared by its boards). `undefined` ⇒ this
   * deployment cannot run the flow for that source, which is a different fact from the source
   * having no OAuth half at all.
   */
  resolveClient(
    workspaceId: string,
    source: DocumentSourceKind,
  ): Promise<DocumentOAuthClient | undefined>
  clock: Clock
  /** Injected for tests; production passes nothing and the global `fetch` is used. */
  fetchImpl?: typeof fetch
  logger?: Logger
}

export class DocumentSourceOAuthService {
  private readonly log: Logger

  constructor(private readonly deps: DocumentSourceOAuthServiceDependencies) {
    this.log = deps.logger ?? noopLogger
  }

  private get http(): typeof fetch {
    return this.deps.fetchImpl ?? fetch
  }

  /**
   * The sources this deployment can connect by OAuth for this workspace: an `oauth` declaration
   * AND a registered client.
   *
   * BOTH halves, because the surface reading it renders a button. A source declaring the half
   * with no client registered would offer a "Connect with Figma" that can only 503, which is the
   * misattribution the separate wire field exists to prevent.
   */
  async availableSources(workspaceId: string): Promise<DocumentSourceKind[]> {
    const declared = this.deps.registry.list().filter((provider) => provider.oauth)
    const resolved = await Promise.all(
      declared.map(async (provider) =>
        (await this.deps.resolveClient(workspaceId, provider.kind)) ? provider.kind : null,
      ),
    )
    return resolved.filter((kind): kind is DocumentSourceKind => kind !== null)
  }

  /**
   * The vendor URL to send the operator's browser to, carrying the caller's signed `state`.
   *
   * Throws rather than answering a status: every failure here is a refusal an operator asked for
   * by pressing a button (a source with no OAuth half, a deployment with no registered app), and
   * a button press deserves a reason rather than a dead link.
   */
  async authorizeUrl(input: {
    workspaceId: string
    source: DocumentSourceKind
    state: string
  }): Promise<string> {
    const { spec, client } = await this.require(input.workspaceId, input.source)
    const url = new URL(spec.authorizeUrl)
    url.searchParams.set('client_id', client.clientId)
    url.searchParams.set('redirect_uri', client.redirectUrl)
    url.searchParams.set('scope', spec.scopes.join(spec.scopeSeparator ?? ' '))
    url.searchParams.set('state', input.state)
    url.searchParams.set('response_type', 'code')
    return url.toString()
  }

  /**
   * Exchange a callback `code` for the credential bag the workspace's connection will hold.
   *
   * It RETURNS the bag rather than storing it, which is what keeps this service free of the
   * connection store: persistence flows one way (the connection service renews through this one),
   * and having the exchange write back would close that into a cycle broken only by a setter.
   * The caller stores it through `DocumentConnectionService.connectWithOAuth`.
   */
  async exchangeCode(input: {
    workspaceId: string
    source: DocumentSourceKind
    code: string
  }): Promise<DocumentCredentials> {
    const { spec, client } = await this.require(input.workspaceId, input.source)
    const tokens = await this.post(spec.tokenUrl, client, {
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: client.redirectUrl,
    })
    return this.bagFrom(tokens)
  }

  /**
   * Renew a stored grant that is at or past its expiry skew, answering the NEW credential bag, or
   * null when there was nothing to do or the renewal could not be made.
   *
   * Null rather than a throw on every failure path, because this sits on the credential-resolution
   * path of every read: a grant that cannot be renewed right now must cost the reader a failed
   * fetch it can report as a source outage, never the read itself. Three states are deliberately
   * distinguished in what it logs, since each needs a different fix: a grant with no refresh
   * token, a source whose spec declares no refresh endpoint (the grant was never renewable, so
   * reconnecting is the only remedy), and a refresh that was attempted and failed.
   *
   * Unguarded against a lost race ON PURPOSE. The endpoints supported here return a new access
   * token against an unchanged refresh token, so two concurrent renewals converge: the loser
   * overwrites an equivalent value rather than replacing a live grant with a dead one, which is
   * the failure a rotating authorization server would make a `compareAndSwap` mandatory for. A
   * source whose refresh ROTATES cannot be added without revisiting this.
   */
  async renewIfExpiring(record: DocumentConnectionRecord): Promise<DocumentCredentials | null> {
    const expiresAt = Number(record.credentials[DOCUMENT_OAUTH_CREDENTIAL_KEYS.expiresAt] ?? '')
    if (!Number.isFinite(expiresAt)) return null
    if (expiresAt - EXPIRY_SKEW_MS > this.deps.clock.now()) return null

    const refreshToken = record.credentials[DOCUMENT_OAUTH_CREDENTIAL_KEYS.refreshToken]
    const spec = this.deps.registry.get(record.source)?.oauth
    if (!refreshToken || !spec?.refreshUrl) {
      this.log.warn('document source OAuth grant expired and cannot be renewed', {
        workspaceId: record.workspaceId,
        source: record.source,
        // Which of the two is missing decides the remedy, and neither is fixable by waiting.
        cause: refreshToken ? 'source_has_no_refresh_endpoint' : 'grant_has_no_refresh_token',
      })
      return null
    }

    const client = await this.deps.resolveClient(record.workspaceId, record.source)
    if (!client) {
      this.log.warn('document source OAuth grant cannot be renewed: no registered app', {
        workspaceId: record.workspaceId,
        source: record.source,
      })
      return null
    }

    try {
      const tokens = await this.post(spec.refreshUrl, client, {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      })
      // A refresh response routinely omits the refresh token it did not rotate, so the stored one
      // is carried forward: taking the response literally would strip the workspace's ability to
      // renew again and turn a working grant into a one-shot one.
      return this.bagFrom({ ...tokens, refresh_token: tokens.refresh_token ?? refreshToken })
    } catch (error) {
      this.log.warn('document source OAuth refresh failed', {
        workspaceId: record.workspaceId,
        source: record.source,
        ...describeError(error),
      })
      return null
    }
  }

  /** The platform-owned credential bag for a token response. */
  private bagFrom(tokens: TokenResponse): DocumentCredentials {
    const accessToken = tokens.access_token?.trim()
    if (!accessToken) {
      throw new UnavailableError(
        'The authorization server returned no access token',
        'oauth_token_missing',
      )
    }
    const lifetime = Number(tokens.expires_in)
    return {
      [DOCUMENT_OAUTH_CREDENTIAL_KEYS.accessToken]: accessToken,
      ...(tokens.refresh_token?.trim()
        ? { [DOCUMENT_OAUTH_CREDENTIAL_KEYS.refreshToken]: tokens.refresh_token.trim() }
        : {}),
      // An absent lifetime means the grant does not expire on a clock we can see; recording a
      // guessed deadline would make `refreshIfExpiring` renew a token nobody said was dying.
      ...(Number.isFinite(lifetime) && lifetime > 0
        ? {
            [DOCUMENT_OAUTH_CREDENTIAL_KEYS.expiresAt]: String(
              this.deps.clock.now() + lifetime * 1000,
            ),
          }
        : {}),
    }
  }

  /** One token-endpoint call, authenticated as the confidential client. */
  private async post(
    url: string,
    client: DocumentOAuthClient,
    params: Record<string, string>,
  ): Promise<TokenResponse> {
    const res = await this.http(url, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
        // HTTP Basic is the RFC 6749 default for a confidential client, and is what both Figma
        // token endpoints accept; the body carries no secret so a proxy log cannot spill it.
        authorization: `Basic ${btoa(`${client.clientId}:${client.clientSecret}`)}`,
      },
      body: new URLSearchParams(params),
    })
    const body = (await res.json().catch(() => ({}))) as TokenResponse
    if (!res.ok) {
      throw new UnavailableError(
        `The authorization server refused the request (HTTP ${res.status}): ` +
          `${body.error_description || body.error || body.message || 'no reason given'}`,
        'oauth_exchange_failed',
      )
    }
    return body
  }

  /** Resolve the source's OAuth declaration + this deployment's registered app, or refuse. */
  private async require(
    workspaceId: string,
    source: DocumentSourceKind,
  ): Promise<{ spec: DocumentSourceOAuthSpec; client: DocumentOAuthClient }> {
    const provider = this.deps.registry.get(source)
    if (!provider) {
      throw new ValidationError(`Unknown or unconfigured document source '${source}'`)
    }
    if (!provider.oauth) {
      throw new ValidationError(
        `${provider.descriptor.label} does not support connecting by OAuth; use its credential form instead.`,
        { reason: 'oauth_not_supported' },
      )
    }
    const client = await this.deps.resolveClient(workspaceId, source)
    if (!client) {
      throw new UnavailableError(
        `This deployment has no registered ${provider.descriptor.label} app, so it cannot run ` +
          `the OAuth connect. An admin registers one in the account's deployment settings.`,
        'oauth_client_not_registered',
      )
    }
    return { spec: provider.oauth, client }
  }
}
