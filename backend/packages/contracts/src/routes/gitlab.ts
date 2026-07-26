import { ContractNoBody, defineApiContract } from '@toad-contracts/valibot'
import * as v from 'valibot'
import { githubConnectionSchema } from '../github.js'
import { errorResponses } from './_shared.js'

// ---------------------------------------------------------------------------
// Workspace-scoped GitLab connect route contracts. Mounted under `/workspaces/:workspaceId`,
// so the paths here are relative to that prefix. See GitLabController.
//
// Unlike GitHub (a GitHub-App installation, connected via a signed setup callback), a GitLab
// workspace connects by pasting a personal access token: the backend validates it, seals it,
// and writes the same `github_installations`/`github_repos` projection rows GitHub uses (the
// tables are VCS-neutral in shape). The connection is surfaced with the SHARED
// `githubConnectionSchema` — it already carries the `provider` discriminator the SPA switches
// presentation on — so there is no GitLab-specific connection wire type.
// ---------------------------------------------------------------------------

/** The pasted PAT the workspace connects with. */
const connectGitLabSchema = v.object({ pat: v.pipe(v.string(), v.minLength(1)) })
const connectionViewSchema = v.object({ connection: v.nullable(githubConnectionSchema) })

export const getGitLabConnectionContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/gitlab/connection',
  responsesByStatusCode: { 200: connectionViewSchema, ...errorResponses },
})

export const connectGitLabContract = defineApiContract({
  method: 'post',
  pathResolver: () => '/gitlab/connection',
  requestBodySchema: connectGitLabSchema,
  responsesByStatusCode: { 201: githubConnectionSchema, ...errorResponses },
})

export const disconnectGitLabContract = defineApiContract({
  method: 'delete',
  pathResolver: () => '/gitlab/connection',
  responsesByStatusCode: { 204: ContractNoBody, ...errorResponses },
})
