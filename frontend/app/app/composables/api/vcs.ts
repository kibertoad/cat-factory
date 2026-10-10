import {
  connectGitLabContract,
  disconnectGitLabContract,
  getGitLabConnectionContract,
  listVcsConnectOptionsContract,
} from '@cat-factory/contracts'
import type { ApiContext } from './context'

/**
 * Provider-neutral VCS connect surface: which connect methods the deployment serves, plus the
 * per-workspace GitLab PAT connect. The GitHub App connect lives in `githubApi` (it is
 * App-specific); everything a workspace does with a repo AFTER connecting — browse, link, sync,
 * pulls, issues — stays on the GitHub-shaped endpoints, which serve GitLab through the adapter.
 */
export function vcsApi({ send, ws }: ApiContext) {
  return {
    // Capability probe: `[]` (or a 403/503) means this workspace has no connect surface at all.
    listVcsConnectOptions: (workspaceId: string) =>
      send(listVcsConnectOptionsContract, { pathPrefix: ws(workspaceId) }),

    // The workspace's GitLab connection, or null. A 503 means GitLab connect isn't wired.
    getGitLabConnection: (workspaceId: string) =>
      send(getGitLabConnectionContract, { pathPrefix: ws(workspaceId) }),

    // Connect by pasting a PAT; the backend validates it upstream before sealing it, so an
    // invalid/insufficient token comes back as a 4xx with a human-readable message.
    connectGitLab: (workspaceId: string, pat: string) =>
      send(connectGitLabContract, { pathPrefix: ws(workspaceId), body: { pat } }),

    disconnectGitLab: (workspaceId: string) =>
      send(disconnectGitLabContract, { pathPrefix: ws(workspaceId) }),
  }
}
