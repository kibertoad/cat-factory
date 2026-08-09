import { defineApiContract } from '@toad-contracts/valibot'
import * as v from 'valibot'
import { vcsProviderSchema } from './auth.js'
import { errorResponses } from './_shared.js'

// ---------------------------------------------------------------------------
// Provider-neutral VCS connect capability. Mounted under `/workspaces/:workspaceId`, so the
// path here is relative to that prefix.
//
// A deployment can serve a GitHub App connect, a per-workspace GitLab PAT connect, both, or
// neither — and the SPA cannot tell which from the connection reads alone (the `github` module
// builds for EITHER provider, so a 200 from `GET /github/connection` says nothing about which
// connect surface is usable). This route is the single signal the connect surfaces switch on,
// so neither an App-less deployment renders the App picker nor a GitLab-less one offers a PAT
// box. It reports CAPABILITY only; the workspace's current connection (and its `provider`) is
// still read from `GET /github/connection`.
// ---------------------------------------------------------------------------

/**
 * How a workspace authenticates to a provider: a GitHub-App installation (`app`) or a pasted
 * personal access token (`pat`). The connect UI is shaped by the method, not just the provider.
 */
export const vcsConnectMethodSchema = v.picklist(['app', 'pat'])
export type VcsConnectMethod = v.InferOutput<typeof vcsConnectMethodSchema>

export const vcsConnectOptionSchema = v.object({
  provider: vcsProviderSchema,
  method: vcsConnectMethodSchema,
  /**
   * The browser-facing base URL of the instance this option would connect to, or null when the
   * deployment's API base does not name one. Same fact the connection carries once bound, and it
   * has to be here too because the surfaces that need it render BEFORE anything is connected:
   * the "create a token" link on the PAT box, and the bootstrap flow's "create a repository"
   * button. Reading it off a connection there is impossible, and defaulting to the provider's
   * public host is what sent a self-managed GitLab user to gitlab.com to make a project the
   * bootstrap run could never push to.
   */
  webUrl: v.nullable(v.string()),
})
export type VcsConnectOption = v.InferOutput<typeof vcsConnectOptionSchema>

export const listVcsConnectOptionsContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/vcs/connect-options',
  responsesByStatusCode: {
    200: v.object({ options: v.array(vcsConnectOptionSchema) }),
    ...errorResponses,
  },
})
