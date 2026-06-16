import type {
  Account,
  AccountMember,
  AddMemberInput,
  AgentRunKind,
  AuthUser,
  Block,
  BlockType,
  BootstrapJob,
  BootstrapRepoInput,
  DocumentBoardPlan,
  DocumentConnection,
  DocumentSourceDescriptor,
  DocumentSourceKind,
  SourceDocument,
  CreateReferenceArchitectureInput,
  ExecutionInstance,
  CommitFilesInput,
  CreateBranchInput,
  CreatedRepo,
  CreateRepoRequest,
  GitHubAvailableRepo,
  GitHubBranch,
  GitHubConnection,
  GitHubInstallationOption,
  GitHubIssue,
  GitHubPullRequest,
  GitHubRepo,
  MergePullRequestInput,
  ModelOption,
  OpenPullRequestInput,
  Pipeline,
  PromptFragment,
  CreatePromptFragmentInput,
  UpdatePromptFragmentInput,
  ResolvedFragment,
  FragmentOwnerKind,
  FragmentSource,
  LinkFragmentSourceInput,
  FragmentSourceStatus,
  FragmentSyncResult,
  ReferenceArchitecture,
  ResyncRequest,
  SpawnResult,
  TaskConnection,
  TaskSourceDescriptor,
  TaskSourceKind,
  SourceTask,
  UpdateReferenceArchitectureInput,
  Workspace,
  WorkspaceSnapshot,
} from '~/types/domain'

type Position = { x: number; y: number }

/**
 * Thin typed client over the cat-factory backend (a Hono worker). Every method
 * maps to one REST endpoint; the request/response shapes mirror
 * `@cat-factory/contracts`, so responses drop straight into the Pinia stores.
 *
 * The base URL comes from runtime config (`NUXT_PUBLIC_API_BASE`), defaulting to
 * the local wrangler dev server — see `nuxt.config.ts`.
 */
export function useApi() {
  const apiBase = useRuntimeConfig().public.apiBase
  const http = $fetch.create({
    baseURL: apiBase,
    // Attach the session token (when signed in) so the backend's auth gate lets
    // the request through. Read lazily from the store so a fresh token applies
    // without rebuilding the client.
    onRequest({ options }) {
      const token = useAuthStore().token
      if (!token) return
      const headers = new Headers(options.headers)
      headers.set('Authorization', `Bearer ${token}`)
      options.headers = headers
    },
    // A 401 means our token lapsed or was revoked — drop it so the UI re-gates.
    onResponseError({ response }) {
      if (response?.status === 401) useAuthStore().handleUnauthorized()
    },
  })

  const ws = (workspaceId: string) => `/workspaces/${encodeURIComponent(workspaceId)}`
  // Prompt-fragment library routes exist at both tiers; resolve the prefix from
  // the owner scope (ADR 0006 §8).
  const scope = (kind: FragmentOwnerKind, id: string) =>
    kind === 'account'
      ? `/accounts/${encodeURIComponent(id)}`
      : `/workspaces/${encodeURIComponent(id)}`

  return {
    // ---- auth -------------------------------------------------------------
    getAuthConfig: () => http<{ enabled: boolean }>('/auth/config'),

    getMe: () => http<{ user: AuthUser | null; enabled: boolean }>('/auth/me'),

    logout: () => http('/auth/logout', { method: 'POST' }),

    // ---- prompt fragments (best-practice catalog) -------------------------
    getPromptFragments: () => http<PromptFragment[]>('/prompt-fragments'),

    // ---- prompt-fragment library (managed, tenant-scoped; ADR 0006) -------
    // The merged catalog an agent actually sees for a board (builtin∪account∪ws).
    getResolvedFragments: (workspaceId: string) =>
      http<ResolvedFragment[]>(`${ws(workspaceId)}/prompt-fragments/resolved`),

    // Per-tier management (scope = account or workspace).
    listFragments: (kind: FragmentOwnerKind, id: string) =>
      http<PromptFragment[]>(`${scope(kind, id)}/prompt-fragments`),

    createFragment: (kind: FragmentOwnerKind, id: string, body: CreatePromptFragmentInput) =>
      http<PromptFragment>(`${scope(kind, id)}/prompt-fragments`, { method: 'POST', body }),

    updateFragment: (
      kind: FragmentOwnerKind,
      id: string,
      fragmentId: string,
      body: UpdatePromptFragmentInput,
    ) =>
      http<PromptFragment>(
        `${scope(kind, id)}/prompt-fragments/${encodeURIComponent(fragmentId)}`,
        { method: 'PATCH', body },
      ),

    deleteFragment: (kind: FragmentOwnerKind, id: string, fragmentId: string) =>
      http(`${scope(kind, id)}/prompt-fragments/${encodeURIComponent(fragmentId)}`, {
        method: 'DELETE',
      }),

    // Repo sources of guideline Markdown.
    listFragmentSources: (kind: FragmentOwnerKind, id: string) =>
      http<FragmentSource[]>(`${scope(kind, id)}/fragment-sources`),

    linkFragmentSource: (kind: FragmentOwnerKind, id: string, body: LinkFragmentSourceInput) =>
      http<FragmentSource>(`${scope(kind, id)}/fragment-sources`, { method: 'POST', body }),

    unlinkFragmentSource: (kind: FragmentOwnerKind, id: string, sourceId: string) =>
      http(`${scope(kind, id)}/fragment-sources/${encodeURIComponent(sourceId)}`, {
        method: 'DELETE',
      }),

    fragmentSourceStatus: (kind: FragmentOwnerKind, id: string, sourceId: string) =>
      http<FragmentSourceStatus>(
        `${scope(kind, id)}/fragment-sources/${encodeURIComponent(sourceId)}/status`,
      ),

    syncFragmentSource: (kind: FragmentOwnerKind, id: string, sourceId: string) =>
      http<FragmentSyncResult>(
        `${scope(kind, id)}/fragment-sources/${encodeURIComponent(sourceId)}/sync`,
        { method: 'POST' },
      ),

    // ---- model picker catalog (effective per-deployment flavours) ---------
    getModels: () => http<ModelOption[]>('/models'),

    // ---- accounts (tenancy) -----------------------------------------------
    // The accounts the user can switch between (personal + orgs), org creation
    // and membership management. Empty when auth is disabled (dev).
    listAccounts: () => http<Account[]>('/accounts'),

    createAccount: (body: { name: string; githubAccountLogin?: string }) =>
      http<Account>('/accounts', { method: 'POST', body }),

    listAccountMembers: (accountId: string) =>
      http<AccountMember[]>(`/accounts/${encodeURIComponent(accountId)}/members`),

    addAccountMember: (accountId: string, body: AddMemberInput) =>
      http<AccountMember>(`/accounts/${encodeURIComponent(accountId)}/members`, {
        method: 'POST',
        body,
      }),

    // ---- workspaces -------------------------------------------------------
    listWorkspaces: () => http<Workspace[]>('/workspaces'),

    createWorkspace: (body: { name?: string; seed?: boolean; accountId?: string } = {}) =>
      http<WorkspaceSnapshot>('/workspaces', { method: 'POST', body }),

    getWorkspace: (workspaceId: string) => http<WorkspaceSnapshot>(ws(workspaceId)),

    renameWorkspace: (workspaceId: string, name: string) =>
      http<Workspace>(ws(workspaceId), { method: 'PATCH', body: { name } }),

    deleteWorkspace: (workspaceId: string) => http(ws(workspaceId), { method: 'DELETE' }),

    // ---- blocks -----------------------------------------------------------
    addFrame: (workspaceId: string, body: { type: BlockType; position: Position }) =>
      http<Block>(`${ws(workspaceId)}/blocks`, { method: 'POST', body }),

    addTask: (workspaceId: string, blockId: string, body: { title?: string } = {}) =>
      http<Block>(`${ws(workspaceId)}/blocks/${blockId}/tasks`, { method: 'POST', body }),

    addModule: (
      workspaceId: string,
      blockId: string,
      body: { name: string; position?: Position },
    ) => http<Block>(`${ws(workspaceId)}/blocks/${blockId}/modules`, { method: 'POST', body }),

    updateBlock: (workspaceId: string, blockId: string, body: Partial<Block>) =>
      http<Block>(`${ws(workspaceId)}/blocks/${blockId}`, { method: 'PATCH', body }),

    moveBlock: (workspaceId: string, blockId: string, body: { position: Position }) =>
      http<Block>(`${ws(workspaceId)}/blocks/${blockId}/move`, { method: 'POST', body }),

    reparentBlock: (
      workspaceId: string,
      blockId: string,
      body: { parentId: string; position: Position },
    ) => http<Block>(`${ws(workspaceId)}/blocks/${blockId}/reparent`, { method: 'POST', body }),

    removeBlock: (workspaceId: string, blockId: string) =>
      http(`${ws(workspaceId)}/blocks/${blockId}`, { method: 'DELETE' }),

    toggleDependency: (workspaceId: string, blockId: string, body: { sourceId: string }) =>
      http<Block>(`${ws(workspaceId)}/blocks/${blockId}/dependencies`, { method: 'POST', body }),

    // ---- pipelines --------------------------------------------------------
    listPipelines: (workspaceId: string) => http<Pipeline[]>(`${ws(workspaceId)}/pipelines`),

    createPipeline: (workspaceId: string, body: { name: string; agentKinds: string[] }) =>
      http<Pipeline>(`${ws(workspaceId)}/pipelines`, { method: 'POST', body }),

    removePipeline: (workspaceId: string, pipelineId: string) =>
      http(`${ws(workspaceId)}/pipelines/${pipelineId}`, { method: 'DELETE' }),

    // ---- executions -------------------------------------------------------
    startExecution: (workspaceId: string, blockId: string, body: { pipelineId: string }) =>
      http<ExecutionInstance>(`${ws(workspaceId)}/blocks/${blockId}/executions`, {
        method: 'POST',
        body,
      }),

    cancelExecution: (workspaceId: string, blockId: string) =>
      http<Block>(`${ws(workspaceId)}/blocks/${blockId}/executions`, { method: 'DELETE' }),

    mergeBlock: (workspaceId: string, blockId: string) =>
      http<Block>(`${ws(workspaceId)}/blocks/${blockId}/merge`, { method: 'POST' }),

    resolveDecision: (
      workspaceId: string,
      executionId: string,
      decisionId: string,
      body: { choice: string },
    ) =>
      http<ExecutionInstance>(
        `${ws(workspaceId)}/executions/${executionId}/decisions/${decisionId}`,
        { method: 'POST', body },
      ),

    // ---- spend safeguard --------------------------------------------------
    resumeSpend: (workspaceId: string) =>
      http<ExecutionInstance[]>(`${ws(workspaceId)}/spend/resume`, { method: 'POST' }),

    // ---- document sources (Confluence, Notion, …) -------------------------
    // The configured sources + their connect/import metadata. A 503 means the
    // integration is off (the store hides its UI on any error here).
    listDocumentSources: (workspaceId: string) =>
      http<{ sources: DocumentSourceDescriptor[] }>(`${ws(workspaceId)}/document-sources`),

    listDocumentConnections: (workspaceId: string) =>
      http<{ connections: DocumentConnection[] }>(
        `${ws(workspaceId)}/document-sources/connections`,
      ),

    connectDocumentSource: (
      workspaceId: string,
      source: DocumentSourceKind,
      credentials: Record<string, string>,
    ) =>
      http<DocumentConnection>(`${ws(workspaceId)}/document-sources/${source}/connect`, {
        method: 'POST',
        body: { credentials },
      }),

    disconnectDocumentSource: (workspaceId: string, source: DocumentSourceKind) =>
      http(`${ws(workspaceId)}/document-sources/${source}/connection`, { method: 'DELETE' }),

    listDocuments: (workspaceId: string) => http<SourceDocument[]>(`${ws(workspaceId)}/documents`),

    importDocument: (workspaceId: string, source: DocumentSourceKind, body: { ref: string }) =>
      http<SourceDocument>(`${ws(workspaceId)}/document-sources/${source}/import`, {
        method: 'POST',
        body,
      }),

    planDocument: (workspaceId: string, source: DocumentSourceKind, externalId: string) =>
      http<DocumentBoardPlan>(`${ws(workspaceId)}/document-sources/${source}/plan`, {
        method: 'POST',
        body: { externalId },
      }),

    spawnDocument: (
      workspaceId: string,
      source: DocumentSourceKind,
      body: { externalId: string; frameId?: string },
    ) =>
      http<{ plan: DocumentBoardPlan; result: SpawnResult }>(
        `${ws(workspaceId)}/document-sources/${source}/spawn`,
        { method: 'POST', body },
      ),

    linkDocument: (
      workspaceId: string,
      body: { source: DocumentSourceKind; externalId: string; blockId: string },
    ) => http<SourceDocument>(`${ws(workspaceId)}/documents/link`, { method: 'POST', body }),

    // ---- task sources (Jira, …) ------------------------------------------
    // The configured trackers + their connect/import metadata. A 503 means the
    // integration is off (the store hides its UI on any error here).
    listTaskSources: (workspaceId: string) =>
      http<{ sources: TaskSourceDescriptor[] }>(`${ws(workspaceId)}/task-sources`),

    listTaskConnections: (workspaceId: string) =>
      http<{ connections: TaskConnection[] }>(`${ws(workspaceId)}/task-sources/connections`),

    connectTaskSource: (
      workspaceId: string,
      source: TaskSourceKind,
      credentials: Record<string, string>,
    ) =>
      http<TaskConnection>(`${ws(workspaceId)}/task-sources/${source}/connect`, {
        method: 'POST',
        body: { credentials },
      }),

    disconnectTaskSource: (workspaceId: string, source: TaskSourceKind) =>
      http(`${ws(workspaceId)}/task-sources/${source}/connection`, { method: 'DELETE' }),

    listTasks: (workspaceId: string) => http<SourceTask[]>(`${ws(workspaceId)}/tasks`),

    importTask: (workspaceId: string, source: TaskSourceKind, body: { ref: string }) =>
      http<SourceTask>(`${ws(workspaceId)}/task-sources/${source}/import`, {
        method: 'POST',
        body,
      }),

    linkTask: (
      workspaceId: string,
      body: { source: TaskSourceKind; externalId: string; blockId: string },
    ) => http<SourceTask>(`${ws(workspaceId)}/tasks/link`, { method: 'POST', body }),

    // ---- github integration ----------------------------------------------
    // Connection management, projection reads (served from D1 — fast and
    // rate-limit-free) and repo writes. A 503 from `getGitHubConnection` means
    // the integration is off (the store hides its UI on any error there).
    getGitHubInstallUrl: (workspaceId: string) =>
      http<{ url: string }>(`${ws(workspaceId)}/github/install-url`),

    getGitHubConnection: (workspaceId: string) =>
      http<{ connection: GitHubConnection | null }>(`${ws(workspaceId)}/github/connection`),

    listGitHubInstallations: (workspaceId: string) =>
      http<{ installations: GitHubInstallationOption[] }>(
        `${ws(workspaceId)}/github/installations`,
      ),

    connectGitHub: (workspaceId: string, installationId: number) =>
      http<GitHubConnection>(`${ws(workspaceId)}/github/connect`, {
        method: 'POST',
        body: { installationId },
      }),

    disconnectGitHub: (workspaceId: string) =>
      http(`${ws(workspaceId)}/github/connection`, { method: 'DELETE' }),

    resyncGitHub: (workspaceId: string, body: ResyncRequest = {}) =>
      http<{ status: string }>(`${ws(workspaceId)}/github/resync`, { method: 'POST', body }),

    listGitHubRepos: (workspaceId: string) => http<GitHubRepo[]>(`${ws(workspaceId)}/github/repos`),

    // Programmatic repo creation (privileged App tier). Only called when the
    // connection reports `canCreateRepos`; otherwise the UI opens GitHub directly.
    createGitHubRepo: (workspaceId: string, body: CreateRepoRequest) =>
      http<CreatedRepo>(`${ws(workspaceId)}/github/repos`, { method: 'POST', body }),

    // Repos the connected installation can access, annotated with whether this
    // workspace links each (drives the per-workspace repo picker).
    listGitHubAvailableRepos: (workspaceId: string) =>
      http<GitHubAvailableRepo[]>(`${ws(workspaceId)}/github/available-repos`),

    // Set the exact set of repos this workspace links.
    setGitHubLinkedRepos: (workspaceId: string, repoGithubIds: number[]) =>
      http<GitHubRepo[]>(`${ws(workspaceId)}/github/repos`, {
        method: 'PUT',
        body: { repoGithubIds },
      }),

    listGitHubBranches: (workspaceId: string, repoGithubId: number) =>
      http<GitHubBranch[]>(`${ws(workspaceId)}/github/repos/${repoGithubId}/branches`),

    listGitHubPullRequests: (workspaceId: string) =>
      http<GitHubPullRequest[]>(`${ws(workspaceId)}/github/pulls`),

    listGitHubIssues: (workspaceId: string) =>
      http<GitHubIssue[]>(`${ws(workspaceId)}/github/issues`),

    createGitHubBranch: (workspaceId: string, repoGithubId: number, body: CreateBranchInput) =>
      http<GitHubBranch>(`${ws(workspaceId)}/github/repos/${repoGithubId}/branches`, {
        method: 'POST',
        body,
      }),

    commitGitHubFiles: (workspaceId: string, repoGithubId: number, body: CommitFilesInput) =>
      http<{ sha: string }>(`${ws(workspaceId)}/github/repos/${repoGithubId}/commits`, {
        method: 'POST',
        body,
      }),

    openGitHubPullRequest: (
      workspaceId: string,
      repoGithubId: number,
      body: OpenPullRequestInput,
    ) =>
      http<GitHubPullRequest>(`${ws(workspaceId)}/github/repos/${repoGithubId}/pulls`, {
        method: 'POST',
        body,
      }),

    mergeGitHubPullRequest: (
      workspaceId: string,
      repoGithubId: number,
      number: number,
      body: MergePullRequestInput = {},
    ) =>
      http(`${ws(workspaceId)}/github/repos/${repoGithubId}/pulls/${number}/merge`, {
        method: 'PUT',
        body,
      }),

    commentGitHubIssue: (
      workspaceId: string,
      repoGithubId: number,
      number: number,
      bodyText: string,
    ) =>
      http(`${ws(workspaceId)}/github/repos/${repoGithubId}/issues/${number}/comments`, {
        method: 'POST',
        body: { body: bodyText },
      }),

    // ---- repo bootstrap ---------------------------------------------------
    listReferenceArchitectures: (workspaceId: string) =>
      http<ReferenceArchitecture[]>(`${ws(workspaceId)}/bootstrap/reference-architectures`),

    createReferenceArchitecture: (workspaceId: string, body: CreateReferenceArchitectureInput) =>
      http<ReferenceArchitecture>(`${ws(workspaceId)}/bootstrap/reference-architectures`, {
        method: 'POST',
        body,
      }),

    updateReferenceArchitecture: (
      workspaceId: string,
      id: string,
      body: UpdateReferenceArchitectureInput,
    ) =>
      http<ReferenceArchitecture>(`${ws(workspaceId)}/bootstrap/reference-architectures/${id}`, {
        method: 'PATCH',
        body,
      }),

    deleteReferenceArchitecture: (workspaceId: string, id: string) =>
      http(`${ws(workspaceId)}/bootstrap/reference-architectures/${id}`, { method: 'DELETE' }),

    bootstrapRepo: (workspaceId: string, body: BootstrapRepoInput) =>
      http<BootstrapJob>(`${ws(workspaceId)}/bootstrap/jobs`, { method: 'POST', body }),

    // ---- agent runs (unified failure + retry) -----------------------------
    // Retry any failed run (bootstrap or execution); the backend resolves the
    // kind from the unified `agent_runs` table and re-drives the right flow.
    retryAgentRun: (workspaceId: string, runId: string) =>
      http<{ kind: AgentRunKind; run: ExecutionInstance | BootstrapJob }>(
        `${ws(workspaceId)}/agent-runs/${encodeURIComponent(runId)}/retry`,
        { method: 'POST' },
      ),
  }
}
