import type {
  DocumentSourceKind,
  DocumentSourceDescriptor,
  DocumentSearchResult,
} from '../domain/types.js'

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
  /** Resolve a stable page id from raw user input (a bare id or a page URL); null if unparseable. */
  parseRef(input: string): string | null
  /** Fetch a single page by its id using the connection credentials. */
  fetchDocument(credentials: DocumentCredentials, externalId: string): Promise<DocumentContent>
  /**
   * Cheaply read the page's current version token — the {@link DocumentContent.version}
   * value {@link fetchDocument} would return, fetched with metadata only (no body
   * download or Markdown conversion). MUST be strictly cheaper than `fetchDocument`,
   * so the caching seam can bump a cached body's TTL when the token is unchanged
   * instead of re-fetching. Returns `''` when the source exposes no version.
   */
  probeVersion(credentials: DocumentCredentials, externalId: string): Promise<string>
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

/** A lookup of the providers wired for this deployment, keyed by source. */
export interface DocumentSourceRegistry {
  /** The provider for a source, or undefined if that source isn't configured. */
  get(kind: DocumentSourceKind): DocumentSourceProvider | undefined
  /** Every configured provider (drives the source list exposed to the UI). */
  list(): DocumentSourceProvider[]
}
