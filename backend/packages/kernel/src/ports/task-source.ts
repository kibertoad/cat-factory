import type {
  BugCandidate,
  TaskSourceKind,
  TaskSourceDescriptor,
  TaskSourceDiagnostic,
  TaskComment,
  TaskDependencyLink,
  TaskSearchResult,
  TrackerBoard,
} from '../domain/types.js'
import type { TaskSourceWebhookAdapter } from './tracker-webhook.js'

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
  // ---- Hierarchy + dependency links (transient: consumed by the epic-spawn import to
  // build the board graph; NOT persisted on the TaskRecord — the board's epicId/dependsOn
  // become the source of truth once spawned). All optional; a source/issue without them
  // simply imports as a flat task. ----
  /** Whether this issue is an epic / parent (Jira epic issue type, or has sub-issues). */
  isEpic?: boolean
  /** The canonical external id of this issue's parent/epic, if any. */
  parentExternalId?: string | null
  /** Canonical external ids of this issue's children (epic children / sub-issues). */
  childExternalIds?: string[]
  /** Dependency relationships this issue declares to other issues. */
  links?: TaskDependencyLink[]
}

/**
 * The ONE repository a search runs in, for a repo-backed source (GitHub Issues): the
 * provider confines its hits to it and resolves a bare issue number against it. Sources
 * with no repo notion (Jira, Linear) have nothing to narrow and ignore it.
 *
 * A repo-backed provider REQUIRES this and refuses a search without it — see
 * {@link TaskSourceProvider.search} for why an unscoped search is not merely broader but
 * unsafe.
 */
export interface TaskSearchRepoScope {
  owner: string
  repo: string
}

/**
 * The rules a REPO-BACKED source states about the one repository an issue of its belongs to.
 * See {@link TaskSourceProvider.repoScope} for why they are one member rather than several.
 */
export interface TaskRepoScopeRules {
  /**
   * Whether an external id of this source names `scope`'s repository.
   *
   * Owned by the source because the COMPARISON differs per vendor: GitHub owner/repo names are
   * case-insensitive, GitLab project paths are not, and a GitLab path NESTS where a GitHub owner
   * is one segment. A shared comparator would have to pick one rule and would then either hide a
   * legitimately-cased GitHub row or fold two distinct GitLab projects together.
   *
   * An id that does not parse (a stale or hand-edited row) is OUT of scope rather than in every
   * scope: a row whose repository cannot be read is not evidence that it is this one.
   */
  matches(externalId: string, scope: TaskSearchRepoScope): boolean
}

/**
 * A predicate search for issue intake (the recurring `bug-intake` step) and for the
 * interactive bug hunt: find **open** issues on one vendor board matching the caller's
 * predicates, **oldest first** (deterministic pickup order). Providers push every
 * predicate into the vendor query wherever the vendor can express it (JQL / GitHub
 * search qualifiers / a Linear GraphQL filter) — never fetch-all-then-filter.
 *
 * The same query vocabulary backs two result shapes: {@link TaskSourceProvider.searchIssues}
 * returns lean hits (intake picks exactly one and imports it straight away), while
 * {@link TaskSourceProvider.listBugCandidates} returns the richer
 * {@link BugCandidate} rows the bug hunt's ranking model needs.
 */
export interface IssueIntakeQuery {
  /**
   * The vendor's "board"/project scope; exactly the field for the provider's source is read.
   * `boardId` is the opaque leg a DEPLOYMENT-REGISTERED source reads (see
   * `issueIntakeConfigSchema` for why it is a separate field rather than a reused built-in one).
   */
  board: {
    jiraProjectKey?: string
    linearTeamId?: string
    githubRepo?: string
    /** GitLab project as its full path with namespace, e.g. `group/sub/project`. */
    gitlabProject?: string
    boardId?: string
  }
  /** Substring that must appear in the issue title. */
  titleFragment?: string
  /** Label(s) that must ALL be present on the issue. */
  labels?: string[]
  /** Issue type name (Jira issue type / GitHub org issue type). Sources without a type notion ignore it. */
  issueType?: string
  /**
   * Restrict to issues with NO assignee. The bug hunt sets it (an unowned bug is what
   * makes a candidate free to pick up); the recurring intake leaves it unset. Absent is
   * treated as `false`, so every existing caller is unaffected.
   */
  unassignedOnly?: boolean
  /**
   * External ids to skip — issues already imported AND linked to a block (being
   * or been worked). Pushed into the vendor query where expressible (Jira
   * `issuekey NOT IN`), else filtered from a bounded overscan.
   */
  excludeExternalIds?: string[]
  /** Max hits to return. Small — the intake step picks exactly one. */
  limit: number
}

/**
 * A selectable "board" on a tracker (Jira project / Linear team / GitHub repository) and one
 * open bug read off one. Both are wire types (`@cat-factory/contracts`, re-exported through
 * `domain/types`), so the provider port, the HTTP layer and the SPA share one definition —
 * see the module comment on `contracts/bug-hunt.ts` for the shape rationale.
 *
 * A `TrackerBoard.id` is vendor-shaped: whatever the matching {@link IssueIntakeQuery.board}
 * field expects (a Jira project KEY, a Linear team id, an `owner/repo` slug), so a listed
 * board can be handed straight back as a query scope.
 */
export type { BugCandidate, TrackerBoard }

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
  /**
   * Present ⇔ this source is REPO-BACKED: every issue of its belongs to one repository, named by
   * its external id. Absent for a source with no repository notion (Jira, Linear).
   *
   * That single fact drives BOTH of the consequences a repo-backed source has, which is why they
   * ride one member instead of a declared flag beside a matcher:
   *
   *  - {@link TaskSourceProvider.search} REQUIRES a {@link TaskSearchRepoScope} and refuses
   *    `null`, so the caller resolves the searching service's repo before it asks.
   *  - The workspace's imported rows are FILTERED to a resolved scope, so a service frame's
   *    quick-pick list holds its own repository's issues and not the connection's other ones.
   *
   * Two members could disagree, and each direction is a live bug that reads as working: a source
   * declared repo-backed with nothing to match by is a search that refuses and a list that never
   * narrows, and a matcher on a source nothing asks to scope is an unscoped vendor search
   * returning whatever the credential can reach. Neither is spellable here.
   */
  readonly repoScope?: TaskRepoScopeRules
  /**
   * Fetch a single issue by its key using the connection credentials.
   *
   * `workspaceId` is the workspace the import runs in, and it is REQUIRED for the same reason
   * {@link TaskSourceProvider.search}'s is: a provider that authenticates out-of-band (GitHub
   * Issues rides the workspace's App; GitLab Issues rides its VCS connection) has no
   * credentials in the bag to resolve, and an external id names a repository, not a tenant.
   * Without it such a provider can only scan every connection on the deployment for one that
   * can read the id, which reads another tenant's issue whenever the ids collide.
   */
  fetchTask(
    credentials: TaskCredentials,
    externalId: string,
    workspaceId: string,
  ): Promise<TaskContent>
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
   * `scope` pins a repo-backed source (one declaring {@link TaskSourceProvider.repoScope}) to a
   * single repository: the one the service the search runs from is linked to, so the results are
   * that service's own issues and a bare issue number resolves against it. It is a REQUIRED
   * parameter carrying a NULLABLE value, deliberately: `null` means "this source has no repo to
   * narrow to" (Jira, Linear), which every caller must state rather than reach by omitting an
   * argument. That distinction is load-bearing, because a repo-backed search is not merely
   * broader without a scope: GitHub's `/search/issues` has no scope of its own, so an unscoped
   * query returns whatever the CREDENTIAL can reach, which under a PAT is every public
   * repository on GitHub, and GitLab's `/search?scope=issues` is the same shape one instance
   * down. A repo-backed provider therefore throws on `null`; a repo-less one ignores it (and its
   * implementation simply declares fewer parameters).
   */
  search?(
    credentials: TaskCredentials,
    query: string,
    workspaceId: string,
    scope: TaskSearchRepoScope | null,
  ): Promise<TaskSearchResult[]>
  /**
   * Predicate search for issue intake: open issues on the query's board matching
   * every predicate, oldest-first, at most `query.limit` lean hits (the returned
   * `externalId`s are valid import refs). Optional: a provider without it cannot
   * back a `bug-intake` schedule. `workspaceId` serves the same per-workspace
   * out-of-band authentication as {@link TaskSourceProvider.search} (the GitHub
   * App ignores `credentials` and scopes to the workspace's installation).
   */
  searchIssues?(
    credentials: TaskCredentials,
    query: IssueIntakeQuery,
    workspaceId: string,
  ): Promise<TaskSearchResult[]>
  /**
   * List the boards a hunt can be scoped to — Jira projects, Linear teams, GitHub
   * repositories. Optional: a provider without it can't back the bug hunt's board
   * picker, and the hunt surface says so rather than offering an empty list.
   * `workspaceId` serves the same per-workspace out-of-band authentication as
   * {@link TaskSourceProvider.search}.
   */
  listBoards?(credentials: TaskCredentials, workspaceId: string): Promise<TrackerBoard[]>
  /**
   * Predicate search returning the RICH {@link BugCandidate} rows the bug hunt ranks —
   * the same query vocabulary as {@link TaskSourceProvider.searchIssues}, but with the
   * body/labels/priority/age the ranking model needs. Implementations MUST gather the
   * whole page in ONE vendor call (vendor field selection / GraphQL projection), never a
   * per-candidate detail fetch. Optional: a provider without it can't back a hunt.
   */
  listBugCandidates?(
    credentials: TaskCredentials,
    query: IssueIntakeQuery,
    workspaceId: string,
  ): Promise<BugCandidate[]>
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
  /**
   * Inbound-webhook capability: verify a delivery signed with the workspace connection's
   * secret and map it onto a neutral {@link TrackerWebhookEvent}. Optional — a provider
   * without it never receives deliveries (the shared receiver 404s that source), which is the
   * push counterpart of a provider without {@link TaskSourceProvider.searchIssues} being
   * unable to back a polling `bug-intake` schedule.
   *
   * Providers own their vendor parsing here exactly as VCS providers own theirs; the shared
   * receiver owns only the transport (raw body, ack fast, hand off to the facade's queue).
   */
  readonly webhook?: TaskSourceWebhookAdapter
}

/** A lookup of the providers wired for this deployment, keyed by source. */
export interface TaskSourceRegistry {
  /** The provider for a source, or undefined if that source isn't configured. */
  get(kind: TaskSourceKind): TaskSourceProvider | undefined
  /** Every configured provider (drives the source list exposed to the UI). */
  list(): TaskSourceProvider[]
}
