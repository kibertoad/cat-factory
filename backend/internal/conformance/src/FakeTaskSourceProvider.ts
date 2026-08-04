import type {
  BugCandidate,
  IssueIntakeQuery,
  TrackerBoard,
  TaskContent,
  TaskCredentials,
  TaskSearchResult,
  TaskSourceDescriptor,
  TaskSourceDiagnostic,
  TaskSourceKind,
  TaskSourceProvider,
  NormalizedTaskConnection,
} from '@cat-factory/kernel'
import {
  GITHUB_ISSUES_DESCRIPTOR,
  JIRA_DESCRIPTOR,
  LINEAR_TASK_DESCRIPTOR,
} from '@cat-factory/integrations'
import { fakeTrackerWebhookAdapter } from './fakeTrackerWebhook.js'

/**
 * The BUILT-IN descriptors, so a fake standing in for a shipped source presents exactly what the
 * real one does. Keyed by string rather than exhaustively by `TaskSourceKind`, because the kind is
 * an open vocabulary: a deployment-registered source has no entry here by construction, and
 * {@link descriptorFor} synthesises one for it.
 */
const BUILTIN_DESCRIPTORS: Record<string, TaskSourceDescriptor> = {
  jira: JIRA_DESCRIPTOR,
  github: GITHUB_ISSUES_DESCRIPTOR,
  linear: LINEAR_TASK_DESCRIPTOR,
}

/**
 * A descriptor for any source kind: the shipped one for a built-in, else a minimal generated one
 * so the suite can register a `<ns>:<name>` source and drive it end to end.
 */
function descriptorFor(kind: TaskSourceKind): TaskSourceDescriptor {
  const builtin = BUILTIN_DESCRIPTORS[kind]
  if (builtin) return builtin
  return {
    source: kind,
    label: kind,
    icon: 'i-lucide-circle-dot',
    credentialFields: [{ key: 'token', label: 'Token', secret: true }],
    refLabel: 'Issue key',
    refPlaceholder: 'ISSUE-1',
    searchable: true,
  }
}

/**
 * Deterministic TaskSourceProvider for the conformance suite + integration tests:
 * serves canned issues and records the credentials it was called with, so tests can
 * assert both the import/link behaviour and that the connection's credentials were
 * used. Unregistered issues fall back to a minimal generated one so simple import
 * tests need no setup. The fake is the seam the real Jira/GitHub provider would
 * occupy — no network.
 */
export class FakeTaskSourceProvider implements TaskSourceProvider {
  readonly descriptor: TaskSourceDescriptor
  /**
   * Inbound-webhook capability, so the shared suite can drive the REAL receiver → gateway →
   * `TrackerWebhookService` path on every facade (see `fakeTrackerWebhook.ts` for why the
   * signature is real but the payload is the neutral event).
   */
  readonly webhook = fakeTrackerWebhookAdapter
  readonly issues = new Map<string, TaskContent>()
  readonly calls: { credentials: TaskCredentials; externalId: string }[] = []
  /** Canned search hits + recorded queries, for the search endpoint tests. */
  searchResults: TaskSearchResult[] = []
  readonly searchCalls: { credentials: TaskCredentials; query: string }[] = []
  /** Recorded issue-intake (`bug-intake`) queries, for the intake-step tests. */
  readonly intakeCalls: { credentials: TaskCredentials; query: IssueIntakeQuery }[] = []
  /** Canned hunt boards + recorded calls, for the bug-hunt board picker. */
  boards: TrackerBoard[] = [{ id: 'PROJ', name: 'Platform', key: 'PROJ' }]
  readonly boardCalls: { credentials: TaskCredentials }[] = []
  /** Recorded bug-hunt candidate queries, so the suite can assert the pushed-down predicates. */
  readonly candidateCalls: { credentials: TaskCredentials; query: IssueIntakeQuery }[] = []
  /** Canned setup-check verdict + recorded calls, for the diagnostics endpoint tests. */
  diagnostic: Omit<TaskSourceDiagnostic, 'source'> = { ok: true, status: 'ready', message: 'ok' }
  readonly diagnoseCalls: { workspaceId: string; credentials: TaskCredentials | null }[] = []

  constructor(
    readonly kind: TaskSourceKind = 'jira',
    issues: Record<string, Partial<TaskContent>> = {},
  ) {
    this.descriptor = descriptorFor(kind)
    for (const [externalId, partial] of Object.entries(issues)) this.set(externalId, partial)
  }

  /** Register (or replace) a canned issue. */
  set(externalId: string, partial: Partial<TaskContent> = {}): void {
    this.issues.set(externalId, {
      title: `Issue ${externalId}`,
      url: `https://example.test/${this.kind}/browse/${externalId}`,
      status: 'To Do',
      type: 'Task',
      assignee: null,
      priority: null,
      labels: [],
      description: '',
      comments: [],
      ...partial,
      externalId,
    })
  }

  /** Accept any credential bag. */
  normalizeConnection(input: TaskCredentials): NormalizedTaskConnection {
    return { credentials: { ...input }, label: `${this.kind} (test)` }
  }

  /** Upper-case a bare-key-ish input as the id; otherwise return null. */
  parseRef(input: string): string | null {
    const trimmed = input.trim()
    return trimmed.length > 0 ? trimmed.toUpperCase() : null
  }

  async fetchTask(credentials: TaskCredentials, externalId: string): Promise<TaskContent> {
    this.calls.push({ credentials, externalId })
    const issue = this.issues.get(externalId)
    if (issue) return issue
    const generated: TaskContent = {
      externalId,
      url: `https://example.test/${this.kind}/browse/${externalId}`,
      title: `Issue ${externalId}`,
      status: 'To Do',
      type: 'Task',
      assignee: null,
      priority: null,
      labels: [],
      description: `Description for ${externalId}`,
      comments: [],
    }
    this.issues.set(externalId, generated)
    return generated
  }

  async search(credentials: TaskCredentials, query: string): Promise<TaskSearchResult[]> {
    this.searchCalls.push({ credentials, query })
    return this.searchResults
  }

  /**
   * Issue-intake predicate search (the `bug-intake` step): derive hits from the registered
   * issues in insertion (oldest-first) order, honouring the exclusion list + the title/label
   * predicates, capped at `limit`. Deterministic and network-free, so the shared conformance
   * suite can drive intake pickup + the no-match no-op against a controlled backlog.
   */
  async searchIssues(
    credentials: TaskCredentials,
    query: IssueIntakeQuery,
  ): Promise<TaskSearchResult[]> {
    this.intakeCalls.push({ credentials, query })
    const excluded = new Set((query.excludeExternalIds ?? []).map((id) => id.toUpperCase()))
    const hits: TaskSearchResult[] = []
    for (const issue of this.issues.values()) {
      if (excluded.has(issue.externalId.toUpperCase())) continue
      if (
        query.titleFragment &&
        !issue.title.toLowerCase().includes(query.titleFragment.toLowerCase())
      ) {
        continue
      }
      if (query.labels?.length && !query.labels.every((l) => issue.labels.includes(l))) continue
      hits.push({
        source: this.kind,
        externalId: issue.externalId,
        title: issue.title,
        url: issue.url,
        status: issue.status,
        excerpt: '',
      })
      if (hits.length >= query.limit) break
    }
    return hits
  }

  /** The boards the hunt's picker lists — canned, so the suite controls what a source offers. */
  async listBoards(credentials: TaskCredentials): Promise<TrackerBoard[]> {
    this.boardCalls.push({ credentials })
    return this.boards
  }

  /**
   * Bug-hunt candidate search: the richer sibling of {@link searchIssues}, over the same
   * registered issues and the same predicates, plus the `unassignedOnly` filter the hunt sets
   * (honoured here against each issue's `assignee`, so the suite can prove an owned bug is
   * never offered as free to take).
   */
  async listBugCandidates(
    credentials: TaskCredentials,
    query: IssueIntakeQuery,
  ): Promise<BugCandidate[]> {
    this.candidateCalls.push({ credentials, query })
    const excluded = new Set((query.excludeExternalIds ?? []).map((id) => id.toUpperCase()))
    const out: BugCandidate[] = []
    for (const issue of this.issues.values()) {
      if (excluded.has(issue.externalId.toUpperCase())) continue
      if (query.unassignedOnly && issue.assignee) continue
      if (
        query.titleFragment &&
        !issue.title.toLowerCase().includes(query.titleFragment.toLowerCase())
      ) {
        continue
      }
      if (query.labels?.length && !query.labels.every((l) => issue.labels.includes(l))) continue
      out.push({
        source: this.kind,
        externalId: issue.externalId,
        title: issue.title,
        url: issue.url,
        status: issue.status,
        type: issue.type,
        priority: issue.priority,
        labels: issue.labels,
        description: issue.description,
        createdAt: '2026-01-01T00:00:00.000Z',
        commentCount: issue.comments.length,
      })
      if (out.length >= query.limit) break
    }
    return out
  }

  async diagnose(input: {
    workspaceId: string
    credentials: TaskCredentials | null
  }): Promise<TaskSourceDiagnostic> {
    this.diagnoseCalls.push({ workspaceId: input.workspaceId, credentials: input.credentials })
    return { source: this.kind, ...this.diagnostic }
  }
}
