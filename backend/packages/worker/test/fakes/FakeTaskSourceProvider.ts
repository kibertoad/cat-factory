import type {
  TaskContent,
  TaskCredentials,
  TaskSourceDescriptor,
  TaskSourceKind,
  TaskSourceProvider,
  NormalizedTaskConnection,
} from '@cat-factory/kernel'
import { JIRA_DESCRIPTOR } from '@cat-factory/integrations'

const DESCRIPTORS: Record<TaskSourceKind, TaskSourceDescriptor> = {
  jira: JIRA_DESCRIPTOR,
}

/**
 * Deterministic TaskSourceProvider for integration tests: serves canned issues
 * and records the credentials it was called with, so tests can assert both the
 * import/link behaviour and that the connection's credentials were used.
 * Unregistered issues fall back to a minimal generated one so simple import tests
 * need no setup. The fake is the seam the real JiraProvider would occupy — no
 * network.
 */
export class FakeTaskSourceProvider implements TaskSourceProvider {
  readonly descriptor: TaskSourceDescriptor
  readonly issues = new Map<string, TaskContent>()
  readonly calls: { credentials: TaskCredentials; externalId: string }[] = []

  constructor(
    readonly kind: TaskSourceKind = 'jira',
    issues: Record<string, Partial<TaskContent>> = {},
  ) {
    this.descriptor = DESCRIPTORS[kind]
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
}
