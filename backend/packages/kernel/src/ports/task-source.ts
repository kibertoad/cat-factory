import type {
  TaskSourceKind,
  TaskSourceDescriptor,
  TaskSourceDiagnostic,
  TaskComment,
  TaskSearchResult,
} from '../domain/types.js'

// Port for a single task source (Jira, …). A provider is the only place that
// knows a source's specifics: how to validate its credentials, how to turn user
// input into a stable issue key, and how to fetch an issue. The worker
// implements each provider with a `fetch`-based client; tests supply a fake.
// Credentials are passed per call because they are stored per workspace, so one
// provider instance serves every workspace.
//
// Unlike a document source (which yields one Markdown body), a task source
// yields a structured {@link TaskContent}: status/type/assignee/priority/labels
// plus a Markdown description and comments. Providers normalize prose fields
// (description, comment bodies) to lightweight Markdown so the generic excerpt
// and prompt-rendering logic stay source-agnostic.

/** A source's per-workspace credentials, as a flat key→value bag. */
export type TaskCredentials = Record<string, string>

export type { TaskComment }

/** An issue fetched from a source, as a structured record. */
export interface TaskContent {
  /** The source's canonical key for the issue (e.g. `PROJ-123`). */
  externalId: string
  /** Canonical web URL of the issue. */
  url: string
  /** Issue summary / title. */
  title: string
  /** Workflow status name, e.g. `In Progress`. */
  status: string
  /** Issue type name, e.g. `Bug`. */
  type: string
  /** Assignee display name, or null when unassigned. */
  assignee: string | null
  /** Priority name, or null when none. */
  priority: string | null
  /** Issue labels. */
  labels: string[]
  /** Description normalized to lightweight Markdown. */
  description: string
  /** Recent comments (oldest→newest), bodies normalized to Markdown. */
  comments: TaskComment[]
}

/**
 * A repo coordinate a search is scoped to, for a repo-backed source (GitHub
 * Issues). When present, the provider restricts its hits to that one repository
 * instead of the whole installation, and can resolve a bare issue number against
 * it. Sources with no repo notion (Jira) ignore it.
 */
export interface TaskSearchRepoScope {
  owner: string
  repo: string
}

/** The result of validating + normalizing connect credentials. */
export interface NormalizedTaskConnection {
  /** The credential bag to persist (trimmed/normalized). */
  credentials: TaskCredentials
  /** A human-friendly label for the connection (site URL). */
  label: string
}

export interface TaskSourceProvider {
  /** Which source this provider serves. */
  readonly kind: TaskSourceKind
  /** Self-description so the UI can render the connect/import forms generically. */
  readonly descriptor: TaskSourceDescriptor
  /**
   * Validate the supplied credentials and return the bag to persist plus a
   * display label. Throws a ValidationError on anything missing/unsafe.
   */
  normalizeConnection(input: TaskCredentials): NormalizedTaskConnection
  /** Resolve a stable issue key from raw user input (a bare key or an issue URL); null if unparseable. */
  parseRef(input: string): string | null
  /** Fetch a single issue by its key using the connection credentials. */
  fetchTask(credentials: TaskCredentials, externalId: string): Promise<TaskContent>
  /**
   * Search the tracker by free text and return lean hits (no description/
   * comments). Optional: a provider that only supports paste-a-URL import omits
   * it (and its descriptor sets `searchable: false`). The provider builds the
   * query and maps the response; the returned `externalId`s are valid import refs.
   *
   * `workspaceId` is the workspace whose connection is searching, so a provider
   * that authenticates per-workspace out-of-band (e.g. the GitHub App, which
   * ignores `credentials`) can scope the search to that workspace's installation
   * instead of leaking across tenants.
   *
   * `scope` (optional) narrows a repo-backed source (GitHub Issues) to a single
   * repository — the one the service the search runs from is linked to — so the
   * results never leak in issues from sibling repos, and a bare issue number /
   * issue URL resolves to that exact issue. Repo-less sources (Jira) ignore it.
   */
  search?(
    credentials: TaskCredentials,
    query: string,
    workspaceId: string,
    scope?: TaskSearchRepoScope,
  ): Promise<TaskSearchResult[]>
  /**
   * Live "check setup" probe: actually authenticate against the source and read a
   * minimal slice of its issues API, classifying any failure (App not installed,
   * missing Issues permission, bad/expired credentials, host unreachable) so the
   * UI can guide setup — distinct from the passive `available` flag.
   *
   * `credentials` is the resolved connection bag for a credentialed source, or
   * `null` for a credentialless one (GitHub rides the workspace's App, so it
   * authenticates out-of-band from `workspaceId`). Optional: a provider without it
   * gets a static verdict from {@link TaskConnectionService} based on availability.
   * Implementations MUST resolve (never reject) — classify into the result.
   */
  diagnose?(input: {
    workspaceId: string
    credentials: TaskCredentials | null
  }): Promise<TaskSourceDiagnostic>
}

/** A lookup of the providers wired for this deployment, keyed by source. */
export interface TaskSourceRegistry {
  /** The provider for a source, or undefined if that source isn't configured. */
  get(kind: TaskSourceKind): TaskSourceProvider | undefined
  /** Every configured provider (drives the source list exposed to the UI). */
  list(): TaskSourceProvider[]
}
