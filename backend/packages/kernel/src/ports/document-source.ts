import type {
  DocumentSourceKind,
  DocumentSourceDescriptor,
  DocumentSearchResult,
} from '../domain/types.js'
import type { DocumentFreshness } from '../domain/document-freshness.js'
import type { DocumentRecord } from './document-repositories.js'

// Port for a single document source (Confluence, Notion, …). A provider is the
// only place that knows a source's specifics: how to validate its credentials,
// how to turn user input into a stable page id, and how to fetch a page. The
// worker implements each provider with a `fetch`-based client; tests supply a
// fake. Credentials are passed per call because they are stored per workspace,
// so one provider instance serves every workspace.
//
// Providers normalize a fetched page body to lightweight Markdown (headings as
// `#`/`##`/`###`, list items as `- `), so the generic planner and excerpt logic
// are source-agnostic.

/** A source's per-workspace credentials, as a flat key→value bag. */
export type DocumentCredentials = Record<string, string>

/** A page fetched from a source, with its body normalized to Markdown. */
export interface DocumentContent {
  /** The source's stable id for the page. */
  externalId: string
  title: string
  /** Canonical web URL of the page. */
  url: string
  /** Body normalized to lightweight Markdown (consumed by the planner/excerpt). */
  body: string
  /**
   * Opaque version token for the fetched content — a value that changes iff the
   * page changed (Confluence version number, Notion `last_edited_time`, a git
   * commit sha, a design-file version). Comparable only by equality; it is the
   * value {@link DocumentSourceProvider.probeVersion} returns, so the caching seam
   * can confirm a cached body is still current with a cheap metadata probe instead
   * of re-fetching the whole page. `''` when the source exposes no version.
   */
  version: string
}

/**
 * The keys an OAuth-granted document-source credential bag carries.
 *
 * PLATFORM-owned, not provider-owned, and that is what keeps the flow source-agnostic: one
 * service runs the grant, writes these three keys, and refreshes them, while a provider's only
 * job is to notice an access token in the bag it is handed and authenticate with it instead of
 * with the typed credential. A per-provider bag shape would put the token lifecycle back inside
 * each provider, which is where it cannot be shared.
 *
 * `oauthExpiresAt` is an ABSOLUTE epoch-ms deadline rather than the `expires_in` the vendor
 * returns: a duration is only meaningful beside the instant it was issued at, and the bag is read
 * days later by a dispatch that has no idea when the grant happened.
 */
export const DOCUMENT_OAUTH_CREDENTIAL_KEYS = {
  accessToken: 'oauthAccessToken',
  refreshToken: 'oauthRefreshToken',
  expiresAt: 'oauthExpiresAt',
} as const

/** The access token in an OAuth-granted bag, or null for a typed credential. */
export function documentOAuthAccessToken(credentials: DocumentCredentials): string | null {
  return credentials[DOCUMENT_OAUTH_CREDENTIAL_KEYS.accessToken]?.trim() || null
}

/** A token set as an authorization server hands it back. */
export interface DocumentOAuthTokens {
  accessToken: string
  refreshToken?: string
  /** Absolute expiry (epoch ms), when the authorization server stated a lifetime. */
  expiresAt?: number
}

/**
 * A source's OAuth (`authorization_code`) half: the endpoints and scopes one shared flow needs to
 * run the grant on its behalf.
 *
 * DECLARATION only, deliberately. No `fetch`, no token parsing, no credential mapping: the whole
 * protocol lives in the platform's own OAuth service, so a second source that gains OAuth adds
 * four constants rather than a second implementation of the flow. The one thing a provider still
 * owns is the OTHER end: reading {@link documentOAuthAccessToken} off the bag it is handed and
 * sending it the way its own API expects.
 */
export interface DocumentSourceOAuthSpec {
  /** The vendor's authorization endpoint (where the operator's browser is sent). */
  readonly authorizeUrl: string
  /** The endpoint the callback's `code` is exchanged at. */
  readonly tokenUrl: string
  /**
   * The endpoint a refresh token is redeemed at, or null when the grant does not refresh.
   *
   * Null is a real answer rather than an unimplemented method: a grant with no refresh endpoint
   * expires for good, and the platform must reconnect rather than retry. Saying so here is what
   * lets the refresh path tell "this token can be renewed and the renewal failed" from "this
   * grant was never renewable".
   */
  readonly refreshUrl: string | null
  /** The scopes requested at authorization, joined by {@link scopeSeparator}. */
  readonly scopes: readonly string[]
  /** How the vendor expects `scope` joined. Defaults to a space (RFC 6749). */
  readonly scopeSeparator?: string
}

/** The result of validating + normalizing connect credentials. */
export interface NormalizedConnection {
  /** The credential bag to persist (trimmed/normalized). */
  credentials: DocumentCredentials
  /** A human-friendly label for the connection (site URL, workspace name). */
  label: string
}

export interface DocumentSourceProvider {
  /** Which source this provider serves. */
  readonly kind: DocumentSourceKind
  /** Self-description so the UI can render the connect/import forms generically. */
  readonly descriptor: DocumentSourceDescriptor
  /**
   * The source's OAuth connect declaration, when it has one. Absent ⇒ the typed credential in
   * {@link descriptor}`.credentialFields` is the only way in.
   *
   * It is paired with `descriptor.oauth`, which is the same fact on the wire. The two are asserted
   * to agree by {@link assertDocumentSourceOAuthAgrees}, which every registry construction runs, so
   * a provider cannot declare endpoints the UI never offers or advertise a button that reaches no
   * flow.
   */
  readonly oauth?: DocumentSourceOAuthSpec
  /**
   * Validate the supplied credentials and return the bag to persist plus a
   * display label. Throws a ValidationError on anything missing/unsafe.
   */
  normalizeConnection(input: DocumentCredentials): NormalizedConnection
  /**
   * For a source that rides an OUT-OF-BAND credential (e.g. the workspace's installed
   * GitHub App) rather than a per-workspace stored connection, resolve whether the
   * workspace is implicitly connected right now — and the marker to present — WITHOUT
   * a stored connection row. Returns null when the source isn't implicitly connected
   * for this workspace (so an explicit connect is still required). Optional: a source
   * that authenticates with its own per-workspace credentials omits it. Today only the
   * GitHub-docs provider implements it (it rides the workspace's App installation),
   * mirroring how the GitHub-issues task source is available as soon as the App is
   * installed with no separate "connect" step.
   */
  resolveImplicitConnection?(workspaceId: string): Promise<NormalizedConnection | null>
  /** Resolve a stable page id from raw user input (a bare id or a page URL); null if unparseable. */
  parseRef(input: string): string | null
  /**
   * The canonical web URL for a page id, rebuilt WITHOUT a fetch: what a pasted share link is
   * trimmed to once its title segment and tracking params are dropped. It is the half of
   * {@link parseRef} an attach surface needs to SHOW someone what their paste resolved to,
   * before any credential is spent or any row is written.
   *
   * OPTIONAL, and the absence is a real fact rather than an unimplemented method: a Confluence
   * page id needs the connection's site base URL and a Linear document id the workspace slug,
   * neither of which the id carries, so those providers can only answer by fetching. The GitHub
   * docs source omits it for a different reason worth keeping distinct: the id carries everything
   * a link needs EXCEPT the host, and the host is a deployment fact (a GitLab-backed deployment
   * reaches the same source through the VCS adapter), so any URL built here would name the wrong
   * one half the time. A caller renders the id itself in all these cases; it must NOT read the
   * absence as a failed resolution.
   */
  canonicalUrl?(externalId: string): string | null
  /**
   * The narrowing qualifier `input` carried that {@link parseRef}'s id does NOT cover, or null.
   *
   * A design source's ref grammar is two-level: a file/project, optionally narrowed to a
   * frame/screen. When the qualifier is one the parser cannot read, `parseRef` deliberately falls
   * back to the CONTAINER rather than guessing which frame was meant, which silently widens the
   * reference from one frame to the whole file. That widening is invisible in the result (a valid
   * id, a valid canonical URL), so the provider that dropped it is the only thing that can say so.
   *
   * OPTIONAL: a source with a single-level grammar has no narrowing to drop, and its absence means
   * exactly that. Implemented by the design sources (Figma, Zeplin). PURE, taking the same raw
   * input `parseRef` took, so it costs a pre-flight nothing.
   */
  droppedScope?(input: string, externalId: string): string | null
  /**
   * Fetch a single page by its id using the connection credentials. `workspaceId` is
   * the workspace on whose behalf the read happens: a provider that authenticates
   * per-workspace out-of-band (e.g. the GitHub App/PAT, which ignores `credentials`)
   * MUST scope the read to that workspace's own installation so a crafted `externalId`
   * can't reach another tenant's repo — the same tenant-scoping `search` performs.
   *
   * **`null` is the DEPLOYMENT scope**: the read is on behalf of the whole deployment, using
   * credentials it configured centrally, and there is no tenant to scope to. A provider whose
   * `deploymentScoped` trait is false MUST refuse it rather than substitute a workspace, because
   * the substitute would be one tenant's credential serving every tenant. `null` is used rather
   * than a sentinel id precisely so that refusal is possible: a fake workspace id would look
   * exactly like a real one to the provider that had to reject it.
   */
  fetchDocument(
    credentials: DocumentCredentials,
    externalId: string,
    workspaceId: string | null,
  ): Promise<DocumentContent>
  /**
   * Cheaply read the page's current version token — the {@link DocumentContent.version}
   * value {@link fetchDocument} would return, fetched with metadata only (no body
   * download or Markdown conversion). MUST be strictly cheaper than `fetchDocument`,
   * so the caching seam can bump a cached body's TTL when the token is unchanged
   * instead of re-fetching. Returns `''` when the source exposes no version. Scoped to
   * `workspaceId` for the same tenant-isolation reason as {@link fetchDocument}, `null`
   * included.
   */
  probeVersion(
    credentials: DocumentCredentials,
    externalId: string,
    workspaceId: string | null,
  ): Promise<string>
  /**
   * Search the source's catalogue by free text and return lean hits (no body).
   * Optional: a provider that only supports paste-a-URL import omits it (and its
   * descriptor sets `searchable: false`). The provider builds the query and maps
   * the response; the returned `externalId`s are valid import refs.
   *
   * `workspaceId` is the workspace whose connection is searching, so a provider
   * that authenticates per-workspace out-of-band (e.g. the GitHub App, which
   * ignores `credentials`) can scope the search to that workspace's installation
   * instead of leaking across tenants.
   */
  search?(
    credentials: DocumentCredentials,
    query: string,
    workspaceId: string,
  ): Promise<DocumentSearchResult[]>
}

/**
 * Live, read-only access to a document source's current content, scoped to a
 * workspace. Resolves the workspace's stored connection and fetches the page —
 * NO local persistence (unlike a document import). This is the narrow seam the
 * execution engine depends on to re-resolve a document-backed prompt fragment at
 * run time, so the runtime-neutral engine never imports the integrations layer.
 */
export interface DocumentContentResolver {
  /** Fetch the page's current content; throws when the source is unreachable / not connected. */
  fetch(
    workspaceId: string,
    source: DocumentSourceKind,
    externalId: string,
  ): Promise<DocumentContent>
  /**
   * Cheaply probe the page's current version token (see
   * {@link DocumentSourceProvider.probeVersion}) — the staleness check the caching
   * seam runs against a cached body's {@link DocumentContent.version}. Throws on the
   * same unreachable/not-connected conditions as {@link fetch}.
   */
  probeVersion(workspaceId: string, source: DocumentSourceKind, externalId: string): Promise<string>
}

/**
 * The cache group every DEPLOYMENT-scoped document body is held under.
 *
 * ONE group for the whole deployment, which is the point: a deployment-wide document keyed per
 * workspace would be fetched N times and could never be invalidated in fewer than N calls, so the
 * group is a fact about the document's OWNER rather than about the reader. Deliberately not a
 * workspace-shaped id, so it cannot collide with one.
 */
export const DEPLOYMENT_DOCUMENT_CACHE_GROUP = 'deployment'

/**
 * Live, read-only access to a document the DEPLOYMENT owns, authenticated with credentials the
 * deployment configured centrally rather than any tenant's connection.
 *
 * The sibling of {@link DocumentContentResolver}, and separate from it because the difference is
 * not a nullable argument but a different CREDENTIAL HOME: this one reads deployment configuration,
 * serves exactly the sources whose `deploymentScoped` trait is true, and caches under one
 * deployment-wide group. Keeping them apart is what lets a caller ask "can the deployment itself
 * serve this document" without a workspace in hand, which is precisely the question a
 * code-registered (`builtin`-tier) prompt fragment's `documentRef` poses.
 *
 * In MOTHERSHIP mode this is remote: the credentials live in the mothership's environment and
 * never reach a node, so the node reads the resolved BODY over `/internal/*`. Like every other
 * such read, a failure THROWS rather than answering empty.
 */
export interface DeploymentDocumentResolver {
  /**
   * Whether this deployment has credentials configured for `source`, so a caller can tell an
   * unconfigured source from an unreachable one WITHOUT spending a fetch.
   *
   * Boot validation is the reader that matters: it refuses a code-registered `documentRef` whose
   * source the deployment cannot serve, and it must be able to distinguish that from a source it
   * can serve but whose page is momentarily unreachable, which is a run-time degradation and not a
   * misconfiguration.
   */
  configured(source: DocumentSourceKind): boolean
  /** Fetch the document's current content; throws when unconfigured or unreachable. */
  fetch(source: DocumentSourceKind, externalId: string): Promise<DocumentContent>
  /** Cheaply probe the current version token; throws on the same conditions as {@link fetch}. */
  probeVersion(source: DocumentSourceKind, externalId: string): Promise<string>
}

/**
 * What one attempt to bring a linked document up to date concluded, in the small shape the
 * dispatch-time cache (`AppCaches.linkedDocumentVersion`) holds.
 *
 * It is the outcome of the WHOLE ladder (probe, and the re-import a moved page triggers), not of
 * the probe alone, which is what lets one cached entry bound both halves. `unreachable` is why it
 * is a value rather than a thrown error: a cache loader that throws caches nothing, so a source
 * outage would re-run the fan-out on every step dispatch for as long as it lasted.
 */
export type LinkedDocumentRefreshOutcome =
  /** The source's current token for this document, as of the attempt. */
  | { readonly status: 'versioned'; readonly version: string }
  /** The source answered but exposes no token to compare against. */
  | { readonly status: 'unversioned' }
  /** The probe or the re-fetch failed. The run reads the stored body; see the logged cause. */
  | { readonly status: 'unreachable' }

/** One linked document as a run is about to read it, with what the refresh concluded about it. */
export interface RefreshedDocument {
  /**
   * The record to read from: the re-imported one when the source had moved, else the stored one
   * unchanged. The refresher returns the RECORD rather than a body so nothing downstream has to
   * merge a partial update onto a row (and so a re-import's new title/url travel with its body).
   */
  readonly record: DocumentRecord
  readonly freshness: DocumentFreshness
}

/**
 * Re-confirm a run's linked documents against their sources at DISPATCH time, so an agent reads the
 * current revision of a page rather than the copy import happened to store.
 *
 * A port rather than a direct call because the work spans two layers the engine cannot see: the
 * provider (`probeVersion` / `fetchDocument`) and the local projection the re-import writes. It sits
 * beside {@link DocumentContentResolver}, which deliberately does NOT persist — the difference is
 * that a fragment owns its own cached body while a linked document IS the stored projection every
 * other reader (the SPA row, the planner, the next dispatch) reads.
 *
 * BEST-EFFORT by contract: it never throws for a document it could not confirm, returning an
 * `unconfirmed` verdict instead, because a source outage must cost the run a stale body and never
 * the run itself. Order and length MIRROR the input, so a caller can zip the results back onto the
 * list it passed.
 */
export interface LinkedDocumentRefresher {
  refresh(
    workspaceId: string,
    documents: readonly DocumentRecord[],
  ): Promise<readonly RefreshedDocument[]>
}

/**
 * Refuse a provider whose two OAuth declarations disagree, at the point it is registered.
 *
 * A source states the same fact twice, and it has to: {@link DocumentSourceProvider.oauth} is what
 * the shared flow RUNS (endpoints, scopes, how the vendor joins them) and `descriptor.oauth` is
 * what the SPA renders from, and the SPA cannot see kernel. Nothing else forces them together, and
 * a source that declares only one half fails SILENTLY in whichever direction it was half-declared:
 * with only the spec, the flow exists and no surface ever offers it; with only the descriptor, a
 * board renders "Connect with <source>" that can do nothing but throw `oauth_not_supported`.
 * Neither shows up as an error anywhere a deployment would look.
 *
 * The SCOPES are held to the same bar as the presence, because the descriptor's copy is not
 * decoration: it is what the operator reads to decide whether to consent, on the page BEFORE the
 * vendor's own. A descriptor asking for less than the flow requests is a consent screen that
 * surprises them, which is the one part of this a wrong value makes worse than a missing one.
 *
 * A plain `Error` rather than a `DomainError`: this is a wiring mistake in a deployment's own code
 * that no request can produce and no operator can fix at runtime, so it belongs to boot, loudly,
 * beside the registration that made it.
 */
export function assertDocumentSourceOAuthAgrees(provider: DocumentSourceProvider): void {
  const spec = provider.oauth
  const wire = provider.descriptor.oauth
  if (!spec && !wire) return
  if (!spec || !wire) {
    const [declared, missing] = spec
      ? ['provider.oauth', 'descriptor.oauth']
      : ['descriptor.oauth', 'provider.oauth']
    throw new Error(
      `Document source '${provider.kind}' declares ${declared} but not ${missing}. ` +
        'Both halves are required: one runs the flow, the other is what offers it.',
    )
  }
  const sent = [...spec.scopes].sort()
  const shown = [...wire.scopes].sort()
  if (sent.length !== shown.length || sent.some((scope, i) => scope !== shown[i])) {
    throw new Error(
      `Document source '${provider.kind}' requests scopes [${sent.join(', ')}] but its descriptor ` +
        `shows [${shown.join(', ')}]. The descriptor is what the operator consents against.`,
    )
  }
}

/** A lookup of the providers wired for this deployment, keyed by source. */
export interface DocumentSourceRegistry {
  /** The provider for a source, or undefined if that source isn't configured. */
  get(kind: DocumentSourceKind): DocumentSourceProvider | undefined
  /** Every configured provider (drives the source list exposed to the UI). */
  list(): DocumentSourceProvider[]
}
