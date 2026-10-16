// Issue trackers, document sources and Slack, for the import, context picker and integrations
// stories. The descriptors are copies of the ones the backend registers (`backend/packages/
// integrations/src/modules/{tasks,documents}/*.logic.ts`), so the labels, help text and
// placeholders read as they do in the app. A copy can go stale: compare it when a story looks off.
import type {
  DocumentConnection,
  DocumentSourceDescriptor,
  ResolvedDocumentRef,
  SlackConnection,
  SourceDocument,
  SourceTask,
  TaskConnection,
  TaskSearchResult,
  TaskSourceDescriptor,
  TaskSourceState,
} from '@cat-factory/contracts'

// ---- Issue trackers ---------------------------------------------------------

export const jiraDescriptor: TaskSourceDescriptor = {
  source: 'jira',
  label: 'Jira',
  icon: 'i-lucide-square-check',
  credentialFields: [
    {
      key: 'baseUrl',
      label: 'Site URL',
      placeholder: 'https://your-team.atlassian.net',
      help: 'e.g. https://your-team.atlassian.net',
    },
    { key: 'accountEmail', label: 'Account email', placeholder: 'you@company.com' },
    {
      key: 'apiToken',
      label: 'API token',
      secret: true,
      placeholder: 'Paste a Jira API token',
      help: 'Create one at id.atlassian.com → Security → API tokens',
    },
  ],
  refLabel: 'Issue key or URL',
  refPlaceholder: 'PROJ-123  or  https://…/browse/PROJ-123',
  searchable: true,
}

export const githubIssuesDescriptor: TaskSourceDescriptor = {
  source: 'github',
  label: 'GitHub Issues',
  icon: 'i-lucide-github',
  credentialFields: [],
  refLabel: 'Issue URL or owner/repo#number',
  refPlaceholder: 'octo/repo#123  or  https://github.com/octo/repo/issues/123',
  searchable: true,
}

export const linearDescriptor: TaskSourceDescriptor = {
  source: 'linear',
  label: 'Linear',
  icon: 'i-lucide-square-kanban',
  credentialFields: [
    {
      key: 'apiKey',
      label: 'Personal API key',
      secret: true,
      placeholder: 'lin_api_…',
      help: 'Create one at linear.app → Settings → Security & access → Personal API keys',
    },
  ],
  refLabel: 'Issue identifier or URL',
  refPlaceholder: 'ENG-123  or  https://linear.app/acme/issue/ENG-123',
  searchable: true,
  oauth: true,
}

/**
 * The trackers as `listTaskSourcesContract` answers them for a workspace on GitHub with Jira
 * connected: GitHub Issues rides the VCS connection, Jira has its own credentials, and Linear is
 * not connected. The derived fields follow the registered providers: all three can back an
 * intake schedule, Linear ignores the issue type predicate, and only GitHub Issues is repo-backed.
 */
export const taskSources: TaskSourceState[] = [
  {
    ...githubIssuesDescriptor,
    available: true,
    enabled: true,
    ridesVcsProvider: 'github',
    supportsIntake: true,
    ignoredIntakePredicates: [],
    repoBacked: true,
  },
  {
    ...jiraDescriptor,
    available: true,
    enabled: true,
    ridesVcsProvider: null,
    supportsIntake: true,
    ignoredIntakePredicates: [],
    repoBacked: false,
  },
  {
    ...linearDescriptor,
    available: false,
    enabled: true,
    ridesVcsProvider: null,
    supportsIntake: true,
    ignoredIntakePredicates: ['issueType'],
    repoBacked: false,
  },
]

/**
 * The tracker connections behind `taskSources`: Jira with its own credentials, labelled with
 * the site as the backend labels it. GitHub Issues rides the VCS connection and has no row.
 */
export const taskConnections: TaskConnection[] = [
  { source: 'jira', label: 'acme.atlassian.net', connectedAt: Date.UTC(2026, 8, 4) },
]

/** One issue pulled from a tracker; `linkedBlockId` is null until a task is made from it. */
export function sourceTask(overrides: Partial<SourceTask> = {}): SourceTask {
  return {
    source: 'jira',
    externalId: 'AUTH-142',
    title: 'Sessions survive a password change',
    url: 'https://acme.atlassian.net/browse/AUTH-142',
    status: 'To Do',
    type: 'Bug',
    assignee: null,
    priority: 'High',
    labels: ['security', 'sessions'],
    description:
      'After a password change, tokens issued before the change still refresh. Revoke every ' +
      'session for the account when the password changes.',
    comments: [
      {
        author: 'Priya Natarajan',
        createdAt: '2026-10-08T14:12:00Z',
        body: 'Reproduced on staging with two browsers.',
      },
    ],
    excerpt: 'After a password change, tokens issued before the change still refresh.',
    linkedBlockId: null,
    syncedAt: Date.UTC(2026, 9, 11, 9, 0),
    ...overrides,
  }
}

/** Three tracker issues: two Jira issues and one GitHub issue, one already linked to a task. */
export const sourceTasks: SourceTask[] = [
  sourceTask(),
  sourceTask({
    externalId: 'AUTH-151',
    title: 'Rate-limit failed logins per account',
    url: 'https://acme.atlassian.net/browse/AUTH-151',
    type: 'Story',
    priority: 'Medium',
    labels: ['security'],
    description: 'Lock an account for 15 minutes after ten failed logins in an hour.',
    comments: [],
    excerpt: 'Lock an account for 15 minutes after ten failed logins in an hour.',
    linkedBlockId: 'task_rate_limit',
  }),
  sourceTask({
    source: 'github',
    externalId: 'acme/auth-service#88',
    title: 'Refresh endpoint returns 500 on an expired token',
    url: 'https://github.com/acme/auth-service/issues/88',
    status: 'open',
    type: 'Issue',
    assignee: 'mkowalski',
    priority: null,
    labels: ['bug'],
    description: 'POST /refresh with an expired token throws instead of answering 401.',
    comments: [],
    excerpt: 'POST /refresh with an expired token throws instead of answering 401.',
  }),
]

/**
 * The GitHub issues already imported from the Auth Service repository: the one in `sourceTasks`
 * and a second, which the import picker lists as quick picks.
 */
export const authServiceIssues: SourceTask[] = [
  sourceTasks[2]!,
  sourceTask({
    source: 'github',
    externalId: 'acme/auth-service#91',
    title: 'Session cookie lacks SameSite on the legacy domain',
    url: 'https://github.com/acme/auth-service/issues/91',
    status: 'open',
    type: 'Issue',
    assignee: null,
    priority: null,
    labels: ['security'],
    description: 'The cookie set by /login on auth.acme.io has no SameSite attribute.',
    comments: [],
    excerpt: 'The cookie set by /login on auth.acme.io has no SameSite attribute.',
  }),
]

/** What a GitHub search for "session" in the Auth Service repository answers. */
export const sessionSearchHits: TaskSearchResult[] = [
  {
    source: 'github',
    externalId: 'acme/auth-service#97',
    title: 'Revoke every session on a password change',
    url: 'https://github.com/acme/auth-service/issues/97',
    status: 'open',
    excerpt: 'Tokens issued before a password change still refresh.',
  },
  {
    source: 'github',
    externalId: 'acme/auth-service#64',
    title: 'Session list shows sessions from deleted devices',
    url: 'https://github.com/acme/auth-service/issues/64',
    status: 'closed',
    excerpt: 'The devices page keeps sessions after the device is removed.',
  },
]

// ---- Document sources -------------------------------------------------------

export const confluenceDescriptor: DocumentSourceDescriptor = {
  source: 'confluence',
  label: 'Confluence',
  icon: 'i-lucide-book-open',
  credentialFields: [
    {
      key: 'baseUrl',
      label: 'Site URL',
      placeholder: 'https://your-team.atlassian.net',
      help: 'e.g. https://your-team.atlassian.net',
    },
    { key: 'accountEmail', label: 'Account email', placeholder: 'you@company.com' },
    {
      key: 'apiToken',
      label: 'API token',
      secret: true,
      placeholder: 'Paste a Confluence API token',
      help: 'Create one at id.atlassian.com → Security → API tokens',
    },
  ],
  refLabel: 'Page URL or ID',
  refPlaceholder: 'https://…/pages/12345/Title  or  12345',
  searchable: true,
}

/** Figma: no catalogue search, and an OAuth half that the deployment may or may not offer. */
export const figmaDescriptor: DocumentSourceDescriptor = {
  source: 'figma',
  label: 'Figma',
  icon: 'i-lucide-figma',
  credentialFields: [
    {
      key: 'apiToken',
      label: 'Personal access token',
      secret: true,
      placeholder: 'figd_…',
      help: 'Create a personal access token at figma.com → Settings → Security → Personal access tokens (file_content + file_variables read scopes). Figma caps a new token at 90 days, so this credential expires on a clock and design imports stop until it is replaced; connecting through OAuth instead renews itself, and an organisation can use a plan access token that outlives any one person. Design tokens require an Enterprise plan; without it the tokens section is simply omitted.',
    },
  ],
  refLabel: 'Figma file or frame URL',
  refPlaceholder: 'https://www.figma.com/design/<key>/Title?node-id=1-2',
  searchable: false,
  oauth: { scopes: ['file_content:read', 'file_variables:read'] },
}

/** Zeplin, the second design source: a link only, like Figma (`ZEPLIN_DESCRIPTOR` in integrations). */
export const zeplinDescriptor: DocumentSourceDescriptor = {
  source: 'zeplin',
  label: 'Zeplin',
  icon: 'i-lucide-layout-template',
  credentialFields: [
    {
      key: 'apiToken',
      label: 'Personal access token',
      secret: true,
      placeholder: 'zeplin PAT',
      help: 'Create a personal access token in Zeplin → Profile → Developer → Personal access tokens. It is stored sealed and shared by the workspace.',
    },
  ],
  refLabel: 'Zeplin project or screen URL',
  refPlaceholder: 'https://app.zeplin.io/project/<projectId>/screen/<screenId>',
  searchable: false,
}

export const githubDocsDescriptor: DocumentSourceDescriptor = {
  source: 'github',
  label: 'GitHub Docs',
  icon: 'i-lucide-file-code-2',
  credentialFields: [],
  refLabel: 'File URL or owner/repo:path',
  refPlaceholder:
    'octo/repo:docs/architecture.md  or  https://github.com/octo/repo/blob/main/README.md',
  searchable: true,
}

/** The sources as `listDocumentSourcesContract` lists them, before the OAuth availability. */
export const documentSources: DocumentSourceDescriptor[] = [
  confluenceDescriptor,
  figmaDescriptor,
  githubDocsDescriptor,
]

/**
 * Confluence and Figma connected with credentials, labelled as the backend labels them (the site
 * URL, the source name). GitHub Docs has no stored row: the listing adds it because the
 * workspace's GitHub App is installed, stamped with the time of the read.
 */
export const documentConnections: DocumentConnection[] = [
  {
    source: 'confluence',
    label: 'https://acme.atlassian.net',
    connectedAt: Date.UTC(2026, 8, 3),
  },
  { source: 'figma', label: 'Figma', connectedAt: Date.UTC(2026, 8, 22) },
  { source: 'github', label: 'GitHub', connectedAt: Date.UTC(2026, 9, 12) },
]

/** One imported Confluence page, not yet linked to a block. */
export function sourceDocument(overrides: Partial<SourceDocument> = {}): SourceDocument {
  return {
    source: 'confluence',
    externalId: '48213377',
    title: 'Session lifecycle',
    url: 'https://acme.atlassian.net/wiki/spaces/AUTH/pages/48213377',
    excerpt: 'How a session is issued, refreshed and revoked, and which service owns each step.',
    linkedBlockId: null,
    role: null,
    docKind: 'technical',
    syncedAt: Date.UTC(2026, 9, 10, 15, 30),
    renderStatus: 'stored',
    ...overrides,
  }
}

/** A Confluence spec, a Figma frame, a template and a GitHub ADR. */
export const sourceDocuments: SourceDocument[] = [
  sourceDocument(),
  sourceDocument({
    source: 'figma',
    externalId: 'Xq3hT9mPa2Lk:1204:88',
    title: 'Sign in, all states',
    url: 'https://www.figma.com/design/Xq3hT9mPa2Lk?node-id=1204-88',
    excerpt: 'Sign in screen: default, error, locked and two-factor states.',
    docKind: 'design',
    renderStatus: 'partial',
  }),
  sourceDocument({
    externalId: '47100210',
    title: 'Service PRD template',
    url: 'https://acme.atlassian.net/wiki/spaces/ENG/pages/47100210',
    excerpt: 'Problem, users, scope, success measures, risks.',
    role: 'template',
    docKind: 'prd',
  }),
  sourceDocument({
    source: 'github',
    externalId: 'acme/auth-service:docs/adr/0007-refresh-rotation.md',
    title: 'ADR 0007: rotate refresh tokens on use',
    url: 'https://github.com/acme/auth-service/blob/main/docs/adr/0007-refresh-rotation.md',
    excerpt: 'Each refresh issues a new refresh token and revokes the one it used.',
    linkedBlockId: 'svc_auth',
    docKind: 'adr',
    renderStatus: null,
  }),
]

/** A pasted Confluence share link, trimmed to the page id. No URL: the id lacks the site. */
export const resolvedDocumentRef: ResolvedDocumentRef = {
  source: 'confluence',
  externalId: '48213377',
  canonicalUrl: null,
  droppedScope: null,
}

/** A pasted Figma frame share link, trimmed to the file key and the frame's node id. */
export const resolvedFigmaFrameRef: ResolvedDocumentRef = {
  source: 'figma',
  externalId: 'Xq3hT9mPa2Lk:1204:88',
  canonicalUrl: 'https://www.figma.com/design/Xq3hT9mPa2Lk?node-id=1204-88',
  droppedScope: null,
}

/**
 * A pasted Figma frame link whose node id the parser could not read, so the reference widens to
 * the whole file. `droppedScope` is the qualifier as pasted.
 */
export const resolvedDocumentRefWithDroppedScope: ResolvedDocumentRef = {
  source: 'figma',
  externalId: 'Xq3hT9mPa2Lk',
  canonicalUrl: 'https://www.figma.com/design/Xq3hT9mPa2Lk',
  droppedScope: 'I2649:14930;2649:14746',
}

// ---- Slack ------------------------------------------------------------------

export const slackConnection: SlackConnection = {
  teamId: 'T04ACME123',
  teamName: 'Acme',
  teamIconUrl: null,
  botUserId: 'U07CATBOT1',
  scopes: ['chat:write', 'chat:write.public', 'channels:read', 'groups:read'],
  connectedAt: Date.UTC(2026, 8, 18),
}
