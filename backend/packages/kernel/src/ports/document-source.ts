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
   */
  fetchDocument(
    credentials: DocumentCredentials,
    externalId: string,
    workspaceId: string,
  ): Promise<DocumentContent>
  /**
   * Cheaply read the page's current version token — the {@link DocumentContent.version}
   * value {@link fetchDocument} would return, fetched with metadata only (no body
   * download or Markdown conversion). MUST be strictly cheaper than `fetchDocument`,
   * so the caching seam can bump a cached body's TTL when the token is unchanged
   * instead of re-fetching. Returns `''` when the source exposes no version. Scoped to
   * `workspaceId` for the same tenant-isolation reason as {@link fetchDocument}.
   */
  probeVersion(
    credentials: DocumentCredentials,
    externalId: string,
    workspaceId: string,
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

/** A lookup of the providers wired for this deployment, keyed by source. */
export interface DocumentSourceRegistry {
  /** The provider for a source, or undefined if that source isn't configured. */
  get(kind: DocumentSourceKind): DocumentSourceProvider | undefined
  /** Every configured provider (drives the source list exposed to the UI). */
  list(): DocumentSourceProvider[]
}
