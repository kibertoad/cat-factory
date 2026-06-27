import { ContractNoBody, defineApiContract, withObjectKeys } from '@toad-contracts/valibot'
import * as v from 'valibot'
import {
  commentSchema,
  commitFilesSchema,
  createBranchSchema,
  createRepoRequestSchema,
  githubAvailableRepoSchema,
  githubBranchSchema,
  githubConnectionSchema,
  githubInstallationOptionSchema,
  githubIssueSchema,
  githubPullRequestSchema,
  githubRepoSchema,
  linkReposSchema,
  mergePullRequestSchema,
  openPullRequestSchema,
  provisionedRepoSchema,
  repoTreeEntrySchema,
  resyncRequestSchema,
  setRepoMonorepoSchema,
} from '../github.js'
import { errorResponses, singleStringParam } from './_shared.js'

// ---------------------------------------------------------------------------
// Workspace-scoped GitHub route contracts. Mounted under `/workspaces/:workspaceId`,
// so the paths here are relative to that prefix. See GitHubController.
// ---------------------------------------------------------------------------

// Programmatic bind body — exists only inline in the controller today.
const connectSchema = v.object({ installationId: v.number() })

// Response wrappers that exist only inline in the controller today.
const installUrlSchema = v.object({ url: v.string() })
const connectionViewSchema = v.object({ connection: v.nullable(githubConnectionSchema) })
const installationsViewSchema = v.object({
  installations: v.array(githubInstallationOptionSchema),
})
const availableReposViewSchema = v.array(githubAvailableRepoSchema)
const repoTreeViewSchema = v.array(repoTreeEntrySchema)
const repoListSchema = v.array(githubRepoSchema)
const branchListSchema = v.array(githubBranchSchema)
const pullRequestListSchema = v.array(githubPullRequestSchema)
const issueListSchema = v.array(githubIssueSchema)
const repoProjectionListSchema = v.array(githubRepoSchema)
const commitResultSchema = v.object({ sha: v.string() })
// The createRepo success body is a freshly-provisioned repo; `provisionedRepoSchema`
// (imported from `../github.js`) is the shared source of truth that the kernel
// `ProvisionedRepo` port type also derives from.
// The resync endpoint returns a `{ status }` envelope across both 200 and 202.
const resyncResultSchema = v.object({
  status: v.picklist(['backfill_started', 'backfilled', 'queued', 'synced']),
})

const repoGithubIdParams = singleStringParam('repoGithubId')
const repoPullNumberParams = withObjectKeys(
  v.object({ repoGithubId: v.string(), number: v.string() }),
)

// ---- connection -----------------------------------------------------------

export const getGitHubInstallUrlContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/github/install-url',
  responsesByStatusCode: { 200: installUrlSchema, ...errorResponses },
})

export const getGitHubConnectionContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/github/connection',
  responsesByStatusCode: { 200: connectionViewSchema, ...errorResponses },
})

export const listGitHubInstallationsContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/github/installations',
  responsesByStatusCode: { 200: installationsViewSchema, ...errorResponses },
})

export const connectGitHubContract = defineApiContract({
  method: 'post',
  pathResolver: () => '/github/connect',
  requestBodySchema: connectSchema,
  responsesByStatusCode: { 201: githubConnectionSchema, ...errorResponses },
})

export const listGitHubAvailableReposContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/github/available-repos',
  responsesByStatusCode: { 200: availableReposViewSchema, ...errorResponses },
})

export const setGitHubLinkedReposContract = defineApiContract({
  method: 'put',
  pathResolver: () => '/github/repos',
  requestBodySchema: linkReposSchema,
  responsesByStatusCode: { 200: repoListSchema, ...errorResponses },
})

export const setGitHubRepoMonorepoContract = defineApiContract({
  method: 'patch',
  requestPathParamsSchema: repoGithubIdParams,
  pathResolver: ({ repoGithubId }) => `/github/repos/${repoGithubId}`,
  requestBodySchema: setRepoMonorepoSchema,
  responsesByStatusCode: { 200: githubRepoSchema, ...errorResponses },
})

export const listGitHubRepoTreeContract = defineApiContract({
  method: 'get',
  requestPathParamsSchema: repoGithubIdParams,
  pathResolver: ({ repoGithubId }) => `/github/repos/${repoGithubId}/tree`,
  requestQuerySchema: v.object({ path: v.optional(v.string()) }),
  responsesByStatusCode: { 200: repoTreeViewSchema, ...errorResponses },
})

export const disconnectGitHubContract = defineApiContract({
  method: 'delete',
  pathResolver: () => '/github/connection',
  responsesByStatusCode: { 204: ContractNoBody, ...errorResponses },
})

// ---- resync ---------------------------------------------------------------

export const resyncGitHubContract = defineApiContract({
  method: 'post',
  pathResolver: () => '/github/resync',
  requestBodySchema: resyncRequestSchema,
  responsesByStatusCode: { 200: resyncResultSchema, 202: resyncResultSchema, ...errorResponses },
})

// ---- projection reads -----------------------------------------------------

export const listGitHubReposContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/github/repos',
  responsesByStatusCode: { 200: repoProjectionListSchema, ...errorResponses },
})

export const listGitHubBranchesContract = defineApiContract({
  method: 'get',
  requestPathParamsSchema: repoGithubIdParams,
  pathResolver: ({ repoGithubId }) => `/github/repos/${repoGithubId}/branches`,
  responsesByStatusCode: { 200: branchListSchema, ...errorResponses },
})

export const listGitHubPullsContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/github/pulls',
  responsesByStatusCode: { 200: pullRequestListSchema, ...errorResponses },
})

export const listGitHubIssuesContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/github/issues',
  responsesByStatusCode: { 200: issueListSchema, ...errorResponses },
})

// ---- writes ---------------------------------------------------------------

export const createGitHubRepoContract = defineApiContract({
  method: 'post',
  pathResolver: () => '/github/repos',
  requestBodySchema: createRepoRequestSchema,
  responsesByStatusCode: { 201: provisionedRepoSchema, ...errorResponses },
})

export const createGitHubBranchContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: repoGithubIdParams,
  pathResolver: ({ repoGithubId }) => `/github/repos/${repoGithubId}/branches`,
  requestBodySchema: createBranchSchema,
  responsesByStatusCode: { 201: githubBranchSchema, ...errorResponses },
})

export const commitGitHubFilesContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: repoGithubIdParams,
  pathResolver: ({ repoGithubId }) => `/github/repos/${repoGithubId}/commits`,
  requestBodySchema: commitFilesSchema,
  responsesByStatusCode: { 201: commitResultSchema, ...errorResponses },
})

export const openGitHubPullRequestContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: repoGithubIdParams,
  pathResolver: ({ repoGithubId }) => `/github/repos/${repoGithubId}/pulls`,
  requestBodySchema: openPullRequestSchema,
  responsesByStatusCode: { 201: githubPullRequestSchema, ...errorResponses },
})

export const mergeGitHubPullRequestContract = defineApiContract({
  method: 'put',
  requestPathParamsSchema: repoPullNumberParams,
  pathResolver: ({ repoGithubId, number }) => `/github/repos/${repoGithubId}/pulls/${number}/merge`,
  requestBodySchema: mergePullRequestSchema,
  responsesByStatusCode: { 204: ContractNoBody, ...errorResponses },
})

export const commentGitHubIssueContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: repoPullNumberParams,
  pathResolver: ({ repoGithubId, number }) =>
    `/github/repos/${repoGithubId}/issues/${number}/comments`,
  requestBodySchema: commentSchema,
  responsesByStatusCode: { 204: ContractNoBody, ...errorResponses },
})
