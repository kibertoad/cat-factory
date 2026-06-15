import type { DocumentSourceKind, DocumentSourceDescriptor } from '../domain/types'

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
}

/** A lookup of the providers wired for this deployment, keyed by source. */
export interface DocumentSourceRegistry {
  /** The provider for a source, or undefined if that source isn't configured. */
  get(kind: DocumentSourceKind): DocumentSourceProvider | undefined
  /** Every configured provider (drives the source list exposed to the UI). */
  list(): DocumentSourceProvider[]
}
