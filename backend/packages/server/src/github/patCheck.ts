import type { GitHubPatCheck, GitHubPatSource, GitHubRepo } from '@cat-factory/contracts'
import { runBestEffort } from '@cat-factory/kernel'
import { probeGitHubPatCapability, type GitHubPatProbeRepo } from '@cat-factory/integrations'
import type { Context } from 'hono'
import type { AppEnv } from '../http/env.js'
import { requestLogger } from '../http/requestLogging.js'

// Assemble the credential check from what the request container already holds.
//
// The question is "can the token a run started HERE, by THIS user, actually push and open a
// pull request" — so the token has to be resolved the way the run path resolves it, not the way
// a settings form would. Two rules follow from that and are the whole point of this module:
//
//  - The INITIATOR's stored PAT is asked for first, through `container.resolveRunInitiatorToken`
//    — the one instance the engine's GitHub client and both facades' dispatch mints share. That
//    is what makes the workspace's `allowInitiatorPat` opt-out count here: on a workspace that
//    refused the preference, a member's own token is not what their runs use, and warning them
//    about it would be a nag about a credential nothing touches.
//  - Only when no initiator token applies does the DEPLOYMENT credential come into play, read
//    off the PAT-login registry's `configuredToken()`. That is local mode's env/installed PAT.
//    A hosted deployment authenticates with a GitHub App, whose entry configures no token, so
//    the check correctly reports `not_applicable` there rather than inventing something to judge.

/** The token a run in this workspace would authenticate as, or null when none is a PAT. */
async function resolveCheckedToken<E extends AppEnv>(
  c: Context<E>,
  workspaceId: string,
): Promise<{ token: string; source: GitHubPatSource } | null> {
  const container = c.get('container')
  const userId = c.get('user')?.id
  const resolveInitiator = container.resolveRunInitiatorToken
  if (userId && resolveInitiator) {
    // Best-effort rather than fatal, and it degrades to the DEPLOYMENT credential rather than to
    // "no check": an unreadable secret store is exactly the condition under which the run path
    // also falls back, so mirroring that fallback keeps this answering about the same token a
    // run would use. The cause is logged by `runBestEffort` rather than swallowed.
    const initiatorToken = await runBestEffort(
      requestLogger(c),
      'resolve initiator personal access token for the credential check',
      () => resolveInitiator({ workspaceId, initiatedBy: userId }),
      { workspaceId },
    )
    if (initiatorToken) return { token: initiatorToken, source: 'initiator' }
  }
  const configured = container.vcsIdentity?.github?.configuredToken?.()
  return configured ? { token: configured, source: 'deployment' } : null
}

/**
 * The repositories to probe a fine-grained token against: the ones this workspace links, which
 * are exactly the rows the projection holds (linking is what writes them, and unlinking
 * tombstones them). GitLab rows are excluded — they are reachable through a different token on a
 * different host, and asking GitHub about one would produce a 404 the fold reads as unreadable.
 */
async function linkedGitHubRepos<E extends AppEnv>(
  c: Context<E>,
  workspaceId: string,
): Promise<GitHubPatProbeRepo[]> {
  const repos: GitHubRepo[] =
    (await c.get('container').repoProjectionRepository?.list(workspaceId)) ?? []
  return repos
    .filter((repo) => (repo.provider ?? 'github') === 'github')
    .map((repo) => ({ owner: repo.owner, name: repo.name }))
}

/**
 * Judge the personal access token this workspace's runs would use. Returns `not_applicable`
 * whenever no PAT is in play, so the SPA makes one call on board load however the deployment
 * authenticates.
 */
export async function checkGitHubPat<E extends AppEnv>(
  c: Context<E>,
  workspaceId: string,
): Promise<GitHubPatCheck> {
  const resolved = await resolveCheckedToken(c, workspaceId)
  if (!resolved) return { state: 'not_applicable' }
  const container = c.get('container')
  return probeGitHubPatCapability(
    {
      token: resolved.token,
      source: resolved.source,
      linkedRepos: await linkedGitHubRepos(c, workspaceId),
      webUrl: container.vcsWebUrls?.github ?? null,
    },
    {
      apiBase: container.config.github.apiBase,
      logger: requestLogger(c),
    },
  )
}
