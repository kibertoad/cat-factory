import type {
  Account,
  AccountInvitation,
  AccountMember,
  AccountRole,
  AddMemberInput,
  EmailConnection,
  UpdateAccountInput,
  AgentRunKind,
  AuthUser,
  Block,
  BlockType,
  CreateTaskType,
  TaskTypeFields,
  WorkspaceSettings,
  UpdateWorkspaceSettingsInput,
  BootstrapJob,
  BootstrapRepoInput,
  DocumentBoardPlan,
  DocumentConnection,
  DocumentSearchResult,
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
  ApiKey,
  AddApiKeyInput,
  ModelDefaults,
  ServiceFragmentDefaults,
  PersonalSubscriptionStatus,
  StorePersonalSubscriptionInput,
  SubscriptionVendor,
  VendorCredential,
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
  RepoTreeEntry,
  ResyncRequest,
  Service,
  SpawnResult,
  TaskConnection,
  TaskSearchResult,
  TaskSourceDescriptor,
  TaskSourceKind,
  SourceTask,
  UpdateReferenceArchitectureInput,
  Workspace,
  WorkspaceMount,
  WorkspaceSnapshot,
} from '~/types/domain'
import type {
  IterationCapChoice,
  LlmCallMetric,
  LlmMetricsExport,
  ReviewComment,
} from '~/types/execution'
import type {
  RequirementReview,
  ResolveRequirementsExceededChoice,
  ReviewItemStatus,
} from '~/types/requirements'
import type { ClarityReview, ResolveClarityExceededChoice } from '~/types/clarity'
import type { Notification } from '~/types/notifications'
import type {
  SlackChannel,
  SlackConnection,
  SlackMemberMappingEntry,
  SlackNotificationSettings,
} from '~/types/slack'
import type {
  MergeThresholdPreset,
  CreateMergePresetInput,
  UpdateMergePresetInput,
} from '~/types/merge'
import type {
  DatadogConnectionView,
  UpsertDatadogConnectionInput,
  ReleaseHealthConfig,
  UpsertReleaseHealthConfigInput,
} from '~/types/releaseHealth'
import type {
  PipelineSchedule,
  ScheduleRun,
  CreateScheduleInput,
  UpdateScheduleInput,
} from '~/types/recurring'
import type { TrackerSettings, PutTrackerSettingsInput } from '~/types/tracker'
import type { ConsensusSession } from '~/types/consensus'
import type {
  LocalModelEndpoint,
  LocalModelEndpointTestResult,
  LocalRunner,
  TestLocalModelEndpointInput,
  UpsertLocalModelEndpointInput,
} from '~/types/localModels'

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

  // The personal-subscription unlock password (individual-usage vendors) rides as an
  // ambient request header — like the bearer token — so it never lands in a request
  // body/wire-contract payload. Mirrors PERSONAL_PASSWORD_HEADER in @cat-factory/contracts.
  const pwHeaders = (password?: string): Record<string, string> | undefined =>
    password ? { 'X-Personal-Password': password } : undefined

  const ws = (workspaceId: string) => `/workspaces/${encodeURIComponent(workspaceId)}`
  // Prompt-fragment library routes exist at both tiers; resolve the prefix from
  // the owner scope (ADR 0006 §8).
  const scope = (kind: FragmentOwnerKind, id: string) =>
    kind === 'account'
      ? `/accounts/${encodeURIComponent(id)}`
      : `/workspaces/${encodeURIComponent(id)}`

  return {
    // ---- auth -------------------------------------------------------------
    getAuthConfig: () =>
      http<{
        enabled: boolean
        providers?: { github: boolean; password: boolean; google: boolean }
        /** Local-mode signals; present only when the backend is the local facade. */
        localMode?: { enabled: boolean; githubPatSetupUrl?: string }
      }>('/auth/config'),

    getMe: () => http<{ user: AuthUser | null; enabled: boolean }>('/auth/me'),

    signup: (body: { email: string; password: string; name?: string; invite?: string }) =>
      http<{ token: string; user: AuthUser }>('/auth/signup', { method: 'POST', body }),

    passwordLogin: (body: { email: string; password: string }) =>
      http<{ token: string; user: AuthUser }>('/auth/password-login', { method: 'POST', body }),

    peekInvite: (token: string) =>
      http<{ valid: boolean; email?: string; accountName?: string | null }>(
        `/auth/invitations/${encodeURIComponent(token)}`,
      ),

    acceptInvite: (token: string) =>
      http<{ accountId: string }>(`/auth/invitations/${encodeURIComponent(token)}/accept`, {
        method: 'POST',
      }),

    logout: () => http('/auth/logout', { method: 'POST' }),

    // Mint a short-lived, workspace-scoped ticket for the events WebSocket. A
    // browser can't set Authorization on a WS handshake, so the socket auths from
    // this `?ticket=` instead of the long-lived session token. Empty string when
    // auth is disabled (dev) — the handshake is open in that case.
    mintEventsTicket: (workspaceId: string) =>
      http<{ ticket: string; expiresInMs?: number }>(`${ws(workspaceId)}/events/ticket`, {
        method: 'POST',
      }),

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
    // Per-workspace catalog: selectability reflects the workspace's (+ account's +
    // caller's) configured API keys and subscription tokens (`available` flag).
    getWorkspaceModels: (workspaceId: string) => http<ModelOption[]>(`${ws(workspaceId)}/models`),

    // ---- direct-provider API keys (the DB-backed pool) --------------------
    // Onboarded via UI, stored encrypted, pooled + rotated. Scoped to a workspace,
    // its owning account, or the signed-in user. Keys are write-only (never returned).
    listWorkspaceApiKeys: (workspaceId: string) =>
      http<{ keys: ApiKey[] }>(`${ws(workspaceId)}/api-keys`),
    addWorkspaceApiKey: (workspaceId: string, body: AddApiKeyInput) =>
      http<ApiKey>(`${ws(workspaceId)}/api-keys`, { method: 'POST', body }),
    removeWorkspaceApiKey: (workspaceId: string, id: string) =>
      http(`${ws(workspaceId)}/api-keys/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    listMyApiKeys: () => http<{ keys: ApiKey[] }>('/me/api-keys'),
    addMyApiKey: (body: AddApiKeyInput) => http<ApiKey>('/me/api-keys', { method: 'POST', body }),
    removeMyApiKey: (id: string) =>
      http(`/me/api-keys/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    // Account-scoped keys (shared by every workspace in the account); admin-only.
    listAccountApiKeys: (accountId: string) =>
      http<{ keys: ApiKey[] }>(`/accounts/${encodeURIComponent(accountId)}/api-keys`),
    addAccountApiKey: (accountId: string, body: AddApiKeyInput) =>
      http<ApiKey>(`/accounts/${encodeURIComponent(accountId)}/api-keys`, { method: 'POST', body }),
    removeAccountApiKey: (accountId: string, id: string) =>
      http(`/accounts/${encodeURIComponent(accountId)}/api-keys/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }),

    // ---- LLM vendor subscription credentials (the token pool) -------------
    listVendorCredentials: (workspaceId: string) =>
      http<{ credentials: VendorCredential[] }>(`${ws(workspaceId)}/vendor-credentials`),
    addVendorCredential: (
      workspaceId: string,
      body: { vendor: SubscriptionVendor; label: string; token: string },
    ) => http<VendorCredential>(`${ws(workspaceId)}/vendor-credentials`, { method: 'POST', body }),
    removeVendorCredential: (workspaceId: string, id: string) =>
      http(`${ws(workspaceId)}/vendor-credentials/${encodeURIComponent(id)}`, { method: 'DELETE' }),

    // ---- personal (individual-usage) subscriptions (per-user, e.g. Claude) ----
    // Stored per signed-in user, double-encrypted under their personal password.
    // Metadata only is returned (never the token). User-scoped (no workspace).
    listPersonalSubscriptions: () =>
      http<{ subscriptions: PersonalSubscriptionStatus[] }>('/personal-subscriptions'),

    storePersonalSubscription: (body: StorePersonalSubscriptionInput) =>
      http<PersonalSubscriptionStatus>('/personal-subscriptions', { method: 'POST', body }),

    removePersonalSubscription: (vendor: SubscriptionVendor) =>
      http(`/personal-subscriptions/${encodeURIComponent(vendor)}`, { method: 'DELETE' }),

    // ---- local model runners (per-user, e.g. Ollama / LM Studio) ----------
    // A developer's own-machine LLM endpoints, stored per signed-in user (the API
    // key is write-only, never returned). User-scoped (no workspace). The enabled
    // models then surface automatically in the per-workspace `/models` catalog.
    listLocalModelEndpoints: () =>
      http<{ endpoints: LocalModelEndpoint[] }>('/local-model-endpoints'),

    upsertLocalModelEndpoint: (provider: LocalRunner, body: UpsertLocalModelEndpointInput) =>
      http<LocalModelEndpoint>(`/local-model-endpoints/${encodeURIComponent(provider)}`, {
        method: 'PUT',
        body,
      }),

    deleteLocalModelEndpoint: (provider: LocalRunner) =>
      http(`/local-model-endpoints/${encodeURIComponent(provider)}`, { method: 'DELETE' }),

    // Probe a runner endpoint for reachability + the models it currently serves
    // (no persistence — drives the "Test connection" model multi-select).
    testLocalModelEndpoint: (body: TestLocalModelEndpointInput) =>
      http<LocalModelEndpointTestResult>('/local-model-endpoints/test', {
        method: 'POST',
        body,
      }),

    // ---- accounts (tenancy) -----------------------------------------------
    // The accounts the user can switch between (personal + orgs), org creation
    // and membership management. Empty when auth is disabled (dev).
    listAccounts: () => http<Account[]>('/accounts'),

    createAccount: (body: { name: string; githubAccountLogin?: string }) =>
      http<Account>('/accounts', { method: 'POST', body }),

    updateAccount: (accountId: string, body: UpdateAccountInput) =>
      http<Account>(`/accounts/${encodeURIComponent(accountId)}`, { method: 'PATCH', body }),

    listAccountMembers: (accountId: string) =>
      http<AccountMember[]>(`/accounts/${encodeURIComponent(accountId)}/members`),

    addAccountMember: (accountId: string, body: AddMemberInput) =>
      http<AccountMember>(`/accounts/${encodeURIComponent(accountId)}/members`, {
        method: 'POST',
        body,
      }),

    setMemberRoles: (accountId: string, userId: string, roles: AccountRole[]) =>
      http<AccountMember>(
        `/accounts/${encodeURIComponent(accountId)}/members/${encodeURIComponent(userId)}/roles`,
        { method: 'PATCH', body: { roles } },
      ),

    // Invitations: invite teammates by email into an org account.
    listInvitations: (accountId: string) =>
      http<AccountInvitation[]>(`/accounts/${encodeURIComponent(accountId)}/invitations`),

    createInvitation: (accountId: string, body: { email: string; roles?: AccountRole[] }) =>
      http<{ invitation: AccountInvitation; acceptUrl: string | null }>(
        `/accounts/${encodeURIComponent(accountId)}/invitations`,
        { method: 'POST', body },
      ),

    revokeInvitation: (accountId: string, invitationId: string) =>
      http(
        `/accounts/${encodeURIComponent(accountId)}/invitations/${encodeURIComponent(invitationId)}`,
        { method: 'DELETE' },
      ),

    // Per-account email sender (UI-onboarded): connect/inspect/disconnect/test.
    getEmailConnection: (accountId: string) =>
      http<{ connection: EmailConnection | null; configured: boolean }>(
        `/accounts/${encodeURIComponent(accountId)}/email-connection`,
      ),

    connectEmail: (
      accountId: string,
      body: { provider: 'sendgrid' | 'resend'; apiKey: string; fromAddress: string },
    ) =>
      http<EmailConnection>(`/accounts/${encodeURIComponent(accountId)}/email-connection`, {
        method: 'POST',
        body,
      }),

    disconnectEmail: (accountId: string) =>
      http(`/accounts/${encodeURIComponent(accountId)}/email-connection`, { method: 'DELETE' }),

    testEmail: (accountId: string, to: string) =>
      http<{ ok: boolean }>(`/accounts/${encodeURIComponent(accountId)}/email-connection/test`, {
        method: 'POST',
        body: { to },
      }),

    // ---- workspaces -------------------------------------------------------
    listWorkspaces: () => http<Workspace[]>('/workspaces'),

    createWorkspace: (
      body: { name?: string; description?: string; seed?: boolean; accountId?: string } = {},
    ) => http<WorkspaceSnapshot>('/workspaces', { method: 'POST', body }),

    getWorkspace: (workspaceId: string) => http<WorkspaceSnapshot>(ws(workspaceId)),

    updateWorkspace: (workspaceId: string, body: { name?: string; description?: string | null }) =>
      http<Workspace>(ws(workspaceId), { method: 'PATCH', body }),

    renameWorkspace: (workspaceId: string, name: string) =>
      http<Workspace>(ws(workspaceId), { method: 'PATCH', body: { name } }),

    deleteWorkspace: (workspaceId: string) => http(ws(workspaceId), { method: 'DELETE' }),

    // ---- blocks -----------------------------------------------------------
    addFrame: (workspaceId: string, body: { type: BlockType; position: Position }) =>
      http<Block>(`${ws(workspaceId)}/blocks`, { method: 'POST', body }),

    // Import an existing GitHub repo as a service frame (no bootstrap run).
    addServiceFromRepo: (
      workspaceId: string,
      body: { repoGithubId: number; position?: Position; directory?: string; isMonorepo?: boolean },
    ) => http<Block>(`${ws(workspaceId)}/blocks/from-repo`, { method: 'POST', body }),

    addTask: (
      workspaceId: string,
      blockId: string,
      body: {
        title: string
        description?: string
        taskType?: CreateTaskType
        taskTypeFields?: TaskTypeFields
        mergePresetId?: string
        pipelineId?: string
        agentConfig?: Record<string, string>
      },
    ) => http<Block>(`${ws(workspaceId)}/blocks/${blockId}/tasks`, { method: 'POST', body }),

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

    createPipeline: (
      workspaceId: string,
      body: {
        name: string
        agentKinds: string[]
        gates?: boolean[]
        thresholds?: (number | null)[]
        enabled?: boolean[]
      },
    ) => http<Pipeline>(`${ws(workspaceId)}/pipelines`, { method: 'POST', body }),

    updatePipeline: (
      workspaceId: string,
      pipelineId: string,
      body: {
        name?: string
        agentKinds?: string[]
        gates?: boolean[]
        thresholds?: (number | null)[]
        enabled?: boolean[]
      },
    ) => http<Pipeline>(`${ws(workspaceId)}/pipelines/${pipelineId}`, { method: 'PATCH', body }),

    clonePipeline: (workspaceId: string, pipelineId: string, body: { name?: string } = {}) =>
      http<Pipeline>(`${ws(workspaceId)}/pipelines/${pipelineId}/clone`, {
        method: 'POST',
        body,
      }),

    removePipeline: (workspaceId: string, pipelineId: string) =>
      http(`${ws(workspaceId)}/pipelines/${pipelineId}`, { method: 'DELETE' }),

    // ---- executions -------------------------------------------------------
    startExecution: (
      workspaceId: string,
      blockId: string,
      body: { pipelineId: string },
      password?: string,
    ) =>
      http<ExecutionInstance>(`${ws(workspaceId)}/blocks/${blockId}/executions`, {
        method: 'POST',
        body,
        headers: pwHeaders(password),
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
      password?: string,
    ) =>
      http<ExecutionInstance>(
        `${ws(workspaceId)}/executions/${executionId}/decisions/${decisionId}`,
        { method: 'POST', body, headers: pwHeaders(password) },
      ),

    approveStep: (
      workspaceId: string,
      executionId: string,
      approvalId: string,
      body: { proposal?: string },
      password?: string,
    ) =>
      http<ExecutionInstance>(
        `${ws(workspaceId)}/executions/${executionId}/steps/${approvalId}/approve`,
        { method: 'POST', body, headers: pwHeaders(password) },
      ),

    requestStepChanges: (
      workspaceId: string,
      executionId: string,
      approvalId: string,
      body: { feedback?: string; comments?: ReviewComment[] },
      password?: string,
    ) =>
      http<ExecutionInstance>(
        `${ws(workspaceId)}/executions/${executionId}/steps/${approvalId}/request-changes`,
        { method: 'POST', body, headers: pwHeaders(password) },
      ),

    rejectStep: (
      workspaceId: string,
      executionId: string,
      approvalId: string,
      body: { reason?: string },
    ) =>
      http<ExecutionInstance>(
        `${ws(workspaceId)}/executions/${executionId}/steps/${approvalId}/reject`,
        { method: 'POST', body },
      ),

    // Resolve a companion step parked at its rework cap: one more round / proceed /
    // stop & reset (the companion analogue of resolveRequirementsExceeded).
    resolveCompanionExceeded: (
      workspaceId: string,
      executionId: string,
      approvalId: string,
      body: { choice: IterationCapChoice },
      password?: string,
    ) =>
      http<ExecutionInstance>(
        `${ws(workspaceId)}/executions/${executionId}/steps/${approvalId}/resolve-exceeded`,
        { method: 'POST', body, headers: pwHeaders(password) },
      ),

    // Restart a run from a chosen step: re-run from `fromStepIndex` onward (resetting
    // that step + later steps' iteration counters) while keeping the earlier steps'
    // outputs as handoff context. Like retry it may need the initiator's personal
    // password for an individual-usage (Claude) block, prompted + retried on a 428.
    restartFromStep: (
      workspaceId: string,
      executionId: string,
      fromStepIndex: number,
      password?: string,
    ) =>
      http<ExecutionInstance>(`${ws(workspaceId)}/executions/${executionId}/restart`, {
        method: 'POST',
        body: { fromStepIndex },
        headers: pwHeaders(password),
      }),

    // ---- LLM observability (per-run model-call metrics) -------------------
    // The full per-call detail behind the board's step rollups. Empty when the
    // observability sink is not wired.
    getLlmMetrics: (workspaceId: string, executionId: string) =>
      http<{ executionId: string; calls: LlmCallMetric[] }>(
        `${ws(workspaceId)}/executions/${encodeURIComponent(executionId)}/llm-metrics`,
      ),

    // The LLM-friendly export bundle (totals + per-agent insights + every call).
    exportLlmMetrics: (workspaceId: string, executionId: string) =>
      http<LlmMetricsExport>(
        `${ws(workspaceId)}/executions/${encodeURIComponent(executionId)}/llm-metrics/export`,
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

    searchDocumentSource: (workspaceId: string, source: DocumentSourceKind, query: string) =>
      http<{ results: DocumentSearchResult[] }>(
        `${ws(workspaceId)}/document-sources/${source}/search`,
        { method: 'POST', body: { query } },
      ),

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

    searchTaskSource: (workspaceId: string, source: TaskSourceKind, query: string) =>
      http<{ results: TaskSearchResult[] }>(`${ws(workspaceId)}/task-sources/${source}/search`, {
        method: 'POST',
        body: { query },
      }),

    linkTask: (
      workspaceId: string,
      body: { source: TaskSourceKind; externalId: string; blockId: string },
    ) => http<SourceTask>(`${ws(workspaceId)}/tasks/link`, { method: 'POST', body }),

    createTaskFromIssue: (
      workspaceId: string,
      body: { source: TaskSourceKind; externalId: string; containerId: string },
    ) =>
      http<{ block: Block; task: SourceTask }>(`${ws(workspaceId)}/tasks/create-block`, {
        method: 'POST',
        body,
      }),

    // ---- requirements review (stateless reviewer agent) ------------------
    // The current review for a block (null when none has been run). A 503 means
    // the feature is unconfigured (the panel hides on any error here).
    getRequirementReview: (workspaceId: string, blockId: string) =>
      http<RequirementReview | null>(
        `${ws(workspaceId)}/blocks/${encodeURIComponent(blockId)}/requirement-review`,
      ),

    // The latest consensus session for a block (`{ session: null }` when none / consensus
    // off). The live transcript also arrives via the `consensus` stream event.
    getConsensusSession: (workspaceId: string, blockId: string) =>
      http<{ session: ConsensusSession | null }>(
        `${ws(workspaceId)}/blocks/${encodeURIComponent(blockId)}/consensus-session`,
      ),

    replyRequirementItem: (workspaceId: string, reviewId: string, itemId: string, reply: string) =>
      http<RequirementReview>(
        `${ws(workspaceId)}/requirement-reviews/${encodeURIComponent(reviewId)}/items/${encodeURIComponent(itemId)}/reply`,
        { method: 'POST', body: { reply } },
      ),

    setRequirementItemStatus: (
      workspaceId: string,
      reviewId: string,
      itemId: string,
      status: ReviewItemStatus,
    ) =>
      http<RequirementReview>(
        `${ws(workspaceId)}/requirement-reviews/${encodeURIComponent(reviewId)}/items/${encodeURIComponent(itemId)}`,
        { method: 'PATCH', body: { status } },
      ),

    // Incorporate the answers ASYNCHRONOUSLY (every finding must be answered or dismissed).
    // The durable driver folds them and re-reviews in the background. Optional `feedback` is
    // the "do it differently" lever when redoing a merge. Returns the `incorporating` review
    // at once; a notification calls the user back only if the re-review needs input.
    incorporateRequirements: (workspaceId: string, blockId: string, feedback?: string) =>
      http<RequirementReview>(
        `${ws(workspaceId)}/blocks/${encodeURIComponent(blockId)}/requirement-review/incorporate`,
        { method: 'POST', body: feedback ? { feedback } : {} },
      ),

    // Re-review the incorporated document (one more reviewer pass). On convergence the
    // parked run advances; otherwise the response carries the next cycle / cap state.
    reReviewRequirements: (workspaceId: string, blockId: string) =>
      http<RequirementReview>(
        `${ws(workspaceId)}/blocks/${encodeURIComponent(blockId)}/requirement-review/re-review`,
        { method: 'POST' },
      ),

    // Proceed: settle the requirements and advance the parked run (all findings dismissed).
    proceedRequirements: (workspaceId: string, blockId: string) =>
      http<RequirementReview>(
        `${ws(workspaceId)}/blocks/${encodeURIComponent(blockId)}/requirement-review/proceed`,
        { method: 'POST' },
      ),

    // Resolve a review that hit its iteration cap: extra-round / proceed / stop-reset.
    resolveRequirementsExceeded: (
      workspaceId: string,
      blockId: string,
      choice: ResolveRequirementsExceededChoice,
    ) =>
      http<RequirementReview>(
        `${ws(workspaceId)}/blocks/${encodeURIComponent(blockId)}/requirement-review/resolve-exceeded`,
        { method: 'POST', body: { choice } },
      ),

    // ---- clarity review (bug-report triage reviewer agent) ---------------
    // The current review for a block (null when none has been run). A 503 means
    // the feature is unconfigured (the panel hides on any error here).
    getClarityReview: (workspaceId: string, blockId: string) =>
      http<ClarityReview | null>(
        `${ws(workspaceId)}/blocks/${encodeURIComponent(blockId)}/clarity-review`,
      ),

    replyClarityItem: (workspaceId: string, reviewId: string, itemId: string, reply: string) =>
      http<ClarityReview>(
        `${ws(workspaceId)}/clarity-reviews/${encodeURIComponent(reviewId)}/items/${encodeURIComponent(itemId)}/reply`,
        { method: 'POST', body: { reply } },
      ),

    setClarityItemStatus: (
      workspaceId: string,
      reviewId: string,
      itemId: string,
      status: ReviewItemStatus,
    ) =>
      http<ClarityReview>(
        `${ws(workspaceId)}/clarity-reviews/${encodeURIComponent(reviewId)}/items/${encodeURIComponent(itemId)}`,
        { method: 'PATCH', body: { status } },
      ),

    // Incorporate the answers ASYNCHRONOUSLY (every finding must be answered or dismissed).
    // The durable driver folds them and re-reviews in the background. Optional `feedback` is
    // the "do it differently" lever when redoing a merge. Returns the `incorporating` review
    // at once; a notification calls the user back only if the re-review needs input.
    incorporateClarity: (workspaceId: string, blockId: string, feedback?: string) =>
      http<ClarityReview>(
        `${ws(workspaceId)}/blocks/${encodeURIComponent(blockId)}/clarity-review/incorporate`,
        { method: 'POST', body: feedback ? { feedback } : {} },
      ),

    // Re-review the clarified report (one more reviewer pass). On convergence the parked run
    // advances; otherwise the response carries the next cycle / cap state.
    reReviewClarity: (workspaceId: string, blockId: string) =>
      http<ClarityReview>(
        `${ws(workspaceId)}/blocks/${encodeURIComponent(blockId)}/clarity-review/re-review`,
        { method: 'POST' },
      ),

    // Proceed: settle the clarity review and advance the parked run (all findings dismissed).
    proceedClarity: (workspaceId: string, blockId: string) =>
      http<ClarityReview>(
        `${ws(workspaceId)}/blocks/${encodeURIComponent(blockId)}/clarity-review/proceed`,
        { method: 'POST' },
      ),

    // Resolve a review that hit its iteration cap: extra-round / proceed / stop-reset.
    resolveClarityExceeded: (
      workspaceId: string,
      blockId: string,
      choice: ResolveClarityExceededChoice,
    ) =>
      http<ClarityReview>(
        `${ws(workspaceId)}/blocks/${encodeURIComponent(blockId)}/clarity-review/resolve-exceeded`,
        { method: 'POST', body: { choice } },
      ),

    // ---- notifications (human-actionable board items) ---------------------
    listNotifications: (workspaceId: string) =>
      http<Notification[]>(`${ws(workspaceId)}/notifications`),

    // Act on a notification (merge the PR / confirm / retry), then resolve it.
    actNotification: (workspaceId: string, id: string) =>
      http<Notification>(`${ws(workspaceId)}/notifications/${encodeURIComponent(id)}/act`, {
        method: 'POST',
      }),

    // Dismiss a notification without acting.
    dismissNotification: (workspaceId: string, id: string) =>
      http<Notification>(`${ws(workspaceId)}/notifications/${encodeURIComponent(id)}/dismiss`, {
        method: 'POST',
      }),

    // ---- merge threshold presets (per-task auto-merge policy library) -----
    listMergePresets: (workspaceId: string) =>
      http<MergeThresholdPreset[]>(`${ws(workspaceId)}/merge-presets`),

    createMergePreset: (workspaceId: string, body: CreateMergePresetInput) =>
      http<MergeThresholdPreset>(`${ws(workspaceId)}/merge-presets`, { method: 'POST', body }),

    updateMergePreset: (workspaceId: string, presetId: string, body: UpdateMergePresetInput) =>
      http<MergeThresholdPreset>(
        `${ws(workspaceId)}/merge-presets/${encodeURIComponent(presetId)}`,
        { method: 'PATCH', body },
      ),

    deleteMergePreset: (workspaceId: string, presetId: string) =>
      http(`${ws(workspaceId)}/merge-presets/${encodeURIComponent(presetId)}`, {
        method: 'DELETE',
      }),

    // ---- workspace runtime settings (human-wait escalation + per-service task limit) --
    getWorkspaceSettings: (workspaceId: string) =>
      http<WorkspaceSettings>(`${ws(workspaceId)}/settings`),

    updateWorkspaceSettings: (workspaceId: string, body: UpdateWorkspaceSettingsInput) =>
      http<WorkspaceSettings>(`${ws(workspaceId)}/settings`, { method: 'PUT', body }),

    // ---- Datadog post-release-health settings -----------------------------
    getDatadogConnection: (workspaceId: string) =>
      http<DatadogConnectionView>(`${ws(workspaceId)}/datadog/connection`),

    setDatadogConnection: (workspaceId: string, body: UpsertDatadogConnectionInput) =>
      http<DatadogConnectionView>(`${ws(workspaceId)}/datadog/connection`, {
        method: 'PUT',
        body,
      }),

    deleteDatadogConnection: (workspaceId: string) =>
      http(`${ws(workspaceId)}/datadog/connection`, { method: 'DELETE' }),

    listReleaseHealthConfigs: (workspaceId: string) =>
      http<ReleaseHealthConfig[]>(`${ws(workspaceId)}/release-health-configs`),

    upsertReleaseHealthConfig: (
      workspaceId: string,
      blockId: string,
      body: UpsertReleaseHealthConfigInput,
    ) =>
      http<ReleaseHealthConfig>(
        `${ws(workspaceId)}/release-health-configs/${encodeURIComponent(blockId)}`,
        { method: 'PUT', body },
      ),

    deleteReleaseHealthConfig: (workspaceId: string, blockId: string) =>
      http(`${ws(workspaceId)}/release-health-configs/${encodeURIComponent(blockId)}`, {
        method: 'DELETE',
      }),

    // ---- per-agent-kind default models (workspace routing overrides) ------
    // The workspace's map of agentKind → model id; a kind absent from the map
    // falls back to the deployment's env routing. `setModelDefaults` replaces the
    // whole map (the settings panel sends the full set on every change).
    getModelDefaults: (workspaceId: string) =>
      http<ModelDefaults>(`${ws(workspaceId)}/model-defaults`),

    setModelDefaults: (workspaceId: string, defaults: Record<string, string>) =>
      http<ModelDefaults>(`${ws(workspaceId)}/model-defaults`, {
        method: 'PUT',
        body: { defaults },
      }),

    // The workspace's default service-fragment selection (the fragment ids new
    // services inherit). `setServiceFragmentDefaults` replaces the whole list.
    getServiceFragmentDefaults: (workspaceId: string) =>
      http<ServiceFragmentDefaults>(`${ws(workspaceId)}/service-fragment-defaults`),

    setServiceFragmentDefaults: (workspaceId: string, fragmentIds: string[]) =>
      http<ServiceFragmentDefaults>(`${ws(workspaceId)}/service-fragment-defaults`, {
        method: 'PUT',
        body: { fragmentIds },
      }),

    // ---- recurring pipelines (scheduled runs against a service) -----------
    listRecurringPipelines: (workspaceId: string) =>
      http<PipelineSchedule[]>(`${ws(workspaceId)}/recurring-pipelines`),

    createRecurringPipeline: (workspaceId: string, body: CreateScheduleInput) =>
      http<PipelineSchedule>(`${ws(workspaceId)}/recurring-pipelines`, { method: 'POST', body }),

    updateRecurringPipeline: (workspaceId: string, id: string, body: UpdateScheduleInput) =>
      http<PipelineSchedule>(`${ws(workspaceId)}/recurring-pipelines/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body,
      }),

    deleteRecurringPipeline: (workspaceId: string, id: string) =>
      http(`${ws(workspaceId)}/recurring-pipelines/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }),

    listScheduleRuns: (workspaceId: string, id: string) =>
      http<ScheduleRun[]>(`${ws(workspaceId)}/recurring-pipelines/${encodeURIComponent(id)}/runs`),

    runScheduleNow: (workspaceId: string, id: string) =>
      http<PipelineSchedule>(
        `${ws(workspaceId)}/recurring-pipelines/${encodeURIComponent(id)}/run-now`,
        { method: 'POST' },
      ),

    // ---- in-org shared services (mount/unmount + org catalog) -------------
    // The services this workspace mounts, and the org catalog it can mount from. A 503
    // means the feature isn't wired (the store hides its UI on any error here).
    listServiceMounts: (workspaceId: string) =>
      http<WorkspaceMount[]>(`${ws(workspaceId)}/services`),

    listServiceCatalog: (workspaceId: string) =>
      http<Service[]>(`${ws(workspaceId)}/services/catalog`),

    mountService: (workspaceId: string, serviceId: string, body: { position?: Position } = {}) =>
      http<WorkspaceMount>(`${ws(workspaceId)}/services/${encodeURIComponent(serviceId)}`, {
        method: 'POST',
        body,
      }),

    unmountService: (workspaceId: string, serviceId: string) =>
      http(`${ws(workspaceId)}/services/${encodeURIComponent(serviceId)}`, { method: 'DELETE' }),

    updateMountLayout: (
      workspaceId: string,
      serviceId: string,
      body: { position?: Position; size?: { w: number; h: number } | null },
    ) =>
      http<WorkspaceMount>(`${ws(workspaceId)}/services/${encodeURIComponent(serviceId)}/layout`, {
        method: 'PATCH',
        body,
      }),

    // ---- issue-tracker selection (workspace-level) ------------------------
    getTrackerSettings: (workspaceId: string) =>
      http<TrackerSettings>(`${ws(workspaceId)}/tracker-settings`),

    putTrackerSettings: (workspaceId: string, body: PutTrackerSettingsInput) =>
      http<TrackerSettings>(`${ws(workspaceId)}/tracker-settings`, { method: 'PUT', body }),

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

    // Browse one level of a (monorepo) repo's tree to pin a service to a subdirectory.
    listGitHubRepoTree: (workspaceId: string, repoGithubId: number, path = '') =>
      http<RepoTreeEntry[]>(`${ws(workspaceId)}/github/repos/${repoGithubId}/tree`, {
        query: { path },
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

    // ---- slack integration (extra notification transport) -----------------
    // Per-account connection (manual bot-token paste + the OAuth "Add to Slack"
    // URL), per-workspace routing, and the per-account member map. A 503 from
    // `getSlackConnection` means the integration is off (the store hides its UI).
    getSlackConnection: (workspaceId: string) =>
      http<{ connection: SlackConnection | null; oauthEnabled: boolean }>(
        `${ws(workspaceId)}/slack/connection`,
      ),

    getSlackInstallUrl: (workspaceId: string) =>
      http<{ url: string }>(`${ws(workspaceId)}/slack/install-url`),

    connectSlack: (workspaceId: string, token: string) =>
      http<SlackConnection>(`${ws(workspaceId)}/slack/connect`, {
        method: 'POST',
        body: { token },
      }),

    disconnectSlack: (workspaceId: string) =>
      http(`${ws(workspaceId)}/slack/connection`, { method: 'DELETE' }),

    listSlackChannels: (workspaceId: string) =>
      http<{ channels: SlackChannel[] }>(`${ws(workspaceId)}/slack/channels`),

    getSlackSettings: (workspaceId: string) =>
      http<SlackNotificationSettings>(`${ws(workspaceId)}/slack/settings`),

    updateSlackSettings: (
      workspaceId: string,
      body: { routes: SlackNotificationSettings['routes']; mentionsEnabled: boolean },
    ) =>
      http<SlackNotificationSettings>(`${ws(workspaceId)}/slack/settings`, { method: 'PUT', body }),

    getSlackMemberMapping: (workspaceId: string) =>
      http<{ entries: SlackMemberMappingEntry[] }>(`${ws(workspaceId)}/slack/member-mapping`),

    updateSlackMemberMapping: (workspaceId: string, entries: SlackMemberMappingEntry[]) =>
      http<{ entries: SlackMemberMappingEntry[] }>(`${ws(workspaceId)}/slack/member-mapping`, {
        method: 'PUT',
        body: { entries },
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
    retryAgentRun: (workspaceId: string, runId: string, password?: string) =>
      http<{ kind: AgentRunKind; run: ExecutionInstance | BootstrapJob }>(
        `${ws(workspaceId)}/agent-runs/${encodeURIComponent(runId)}/retry`,
        { method: 'POST', headers: pwHeaders(password) },
      ),

    // Explicitly stop a running run (bootstrap or execution): the backend kills the
    // per-run container and tears down the durable driver, then marks the run
    // terminally cancelled so the board stops showing it as running.
    stopAgentRun: (workspaceId: string, runId: string) =>
      http<{ kind: AgentRunKind; run: ExecutionInstance | BootstrapJob }>(
        `${ws(workspaceId)}/agent-runs/${encodeURIComponent(runId)}/stop`,
        { method: 'POST' },
      ),
  }
}
