import type { GitHubPatCheck, GitHubPatSource } from '@cat-factory/contracts'
import { runBestEffort } from '@cat-factory/kernel'
import { probeGitHubPatCapability, type GitHubPatProbeRepo } from '@cat-factory/integrations'
import type { Context } from 'hono'
import type { AppEnv, ServerContainer } from '../http/env.js'
import { requestLogger } from '../http/requestLogging.js'

// Assemble the credential check from what the request container already holds.
//
// The question is "can the token a run started HERE, by THIS user, actually push and open a
// pull request" — so both halves of it have to be resolved the way the run path resolves them,
// not the way a settings form would. Three rules follow from that and are the whole point of
// this module:
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
//  - A token is judged only where a run WOULD PRESENT IT, and that is what the run-repo read
//    decides. A workspace whose services target no GitHub repository authenticates to GitHub
//    nowhere: it may be bound to GitLab, or have nothing linked yet, and in both cases a stored
//    GitHub token is a credential this board's pipelines never reach for. Judging it anyway
//    raised the product's loudest banner over a board that could not have used it.
//
// Every container read below goes through `containerOf` rather than `c.get('container')`
// directly. Under the generic `E extends AppEnv` these controllers are written against, Hono's
// `get` cannot resolve the variable's type and yields `any`, so a read of a field the container
// does not actually carry compiles and returns `undefined` forever. This module shipped with
// exactly that: a repository name nothing attaches, whose absence silently emptied the probe
// list, so every fine-grained token reported `unknown` and the endpoint could not fail.

/** The request's container, TYPED — see the note above on why `c.get` alone is not enough. */
function containerOf<E extends AppEnv>(c: Context<E>): ServerContainer {
  return c.get('container')
}

/** The token a run in this workspace would authenticate as, or null when none is a PAT. */
async function resolveCheckedToken<E extends AppEnv>(
  c: Context<E>,
  workspaceId: string,
): Promise<{ token: string; source: GitHubPatSource } | null> {
  const container = containerOf(c)
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
 * The GitHub repositories this workspace's runs would push to: its mounted services' repo
 * links, read through the same seam the run path resolves a block's repo with.
 *
 * GitLab-provider rows are dropped rather than probed. They are reachable through a different
 * token on a different host, so asking GitHub about one produces a 404 the fold would read as a
 * repository the token was denied. Dropping them is also what makes an EMPTY result the honest
 * answer for a GitLab-bound board: no GitHub repository is targeted, so no GitHub token is in
 * play, whatever a member happens to have stored.
 *
 * Absent seam ⇒ empty. A facade with no run-repo resolution wired has no GitHub run path
 * either, so it has nothing to judge, and inventing a probe list would be worse than saying so.
 */
async function githubRunRepos<E extends AppEnv>(
  c: Context<E>,
  workspaceId: string,
): Promise<GitHubPatProbeRepo[]> {
  const listRunRepos = containerOf(c).listWorkspaceRunRepos
  if (!listRunRepos) return []
  const repos = await listRunRepos(workspaceId)
  return repos
    .filter((repo) => repo.provider === 'github')
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
  // Read the run targets BEFORE spending a round trip on GitHub: with none, there is no verdict
  // to reach and the outbound call would be pure cost. This is also the provider gate, and it
  // covers the CLASSIC path as much as the fine-grained one — a classic token's scopes are
  // readable without any repository, which is exactly how a scope verdict came to be rendered
  // over a board whose runs never touch GitHub.
  const targetRepos = await githubRunRepos(c, workspaceId)
  if (targetRepos.length === 0) return { state: 'not_applicable' }
  const container = containerOf(c)
  return probeGitHubPatCapability(
    {
      token: resolved.token,
      source: resolved.source,
      targetRepos,
      webUrl: container.vcsWebUrls?.github ?? null,
    },
    {
      apiBase: container.config.github.apiBase,
      logger: requestLogger(c),
    },
  )
}
