import {
  commentSchema,
  commitFilesSchema,
  createBranchSchema,
  createRepoRequestSchema,
  linkReposSchema,
  mergePullRequestSchema,
  openPullRequestSchema,
  resyncRequestSchema,
} from '@cat-factory/contracts'
import * as v from 'valibot'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { GitHubModule } from '@cat-factory/core'
import type { AppEnv } from '../../infrastructure/http/types'
import { param } from '../../infrastructure/http/params'
import { jsonBody } from '../../infrastructure/http/validation'
import { StateSigner } from '../../infrastructure/github/state'

const connectSchema = v.object({ installationId: v.number() })

/** Resolve the GitHub module or send a 503, returning null when unconfigured. */
function requireGitHub(c: Context<AppEnv>): GitHubModule | null {
  return c.get('container').github ?? null
}

const unavailable = (c: Context<AppEnv>) =>
  c.json({ error: { code: 'unavailable', message: 'GitHub integration is not configured' } }, 503)

/**
 * Workspace-scoped GitHub endpoints: connection management, projection reads
 * (served from D1 — fast and rate-limit-free), resync triggers, and repo writes.
 * Mounted under `/workspaces/:workspaceId`.
 */
export function githubController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // ---- connection ---------------------------------------------------------

  // The URL the frontend should redirect to so a workspace owner can install
  // the App; carries an HMAC-signed `state` binding the install to this workspace.
  app.get('/github/install-url', async (c) => {
    const github = requireGitHub(c)
    if (!github) return unavailable(c)
    const config = c.get('container').config.github
    const signer = new StateSigner(c.env.GITHUB_WEBHOOK_SECRET ?? '')
    // Bind the install to this workspace AND the signed-in user, with a short
    // expiry. (The per-workspace authorization middleware has already confirmed
    // the caller owns :workspaceId before this handler runs.)
    const state = await signer.sign({
      workspaceId: param(c, 'workspaceId'),
      userId: c.get('user')?.id ?? null,
      exp: Date.now() + 10 * 60 * 1000,
    })
    const url = `https://github.com/apps/${config.appSlug}/installations/new?state=${encodeURIComponent(state)}`
    return c.json({ url })
  })

  app.get('/github/connection', async (c) => {
    const github = requireGitHub(c)
    if (!github) return unavailable(c)
    const connection = await github.installationService.getConnection(param(c, 'workspaceId'))
    return c.json({ connection })
  })

  // Discover the App's installations so the UI can offer a pick instead of a
  // manually typed installation id (the caller already owns :workspaceId).
  app.get('/github/installations', async (c) => {
    const github = requireGitHub(c)
    if (!github) return unavailable(c)
    const installations = await github.installationService.listAvailableInstallations(
      param(c, 'workspaceId'),
    )
    return c.json({ installations })
  })

  // Programmatic bind (the browser flow uses /github/setup/callback instead).
  // Used by the "discover & link" picker and connect-by-id. Binds the installation
  // to the workspace's account; repos are then linked explicitly (see below), so
  // there is no whole-installation backfill on connect.
  app.post('/github/connect', jsonBody(connectSchema), async (c) => {
    const github = requireGitHub(c)
    if (!github) return unavailable(c)
    const workspaceId = param(c, 'workspaceId')
    const { installationId } = c.req.valid('json')
    const connection = await github.installationService.connect(workspaceId, installationId)
    return c.json(connection, 201)
  })

  // The repos the connected installation can access, annotated with whether this
  // workspace links each. Drives the per-workspace repo picker.
  app.get('/github/available-repos', async (c) => {
    const github = requireGitHub(c)
    if (!github) return unavailable(c)
    return c.json(await github.syncService.listAvailableRepos(param(c, 'workspaceId')))
  })

  // Set the exact set of repos this workspace links. Projects the selection,
  // tombstones the rest, and deep-syncs the linked repos.
  app.put('/github/repos', jsonBody(linkReposSchema), async (c) => {
    const github = requireGitHub(c)
    if (!github) return unavailable(c)
    const repos = await github.syncService.setLinkedRepos(
      param(c, 'workspaceId'),
      c.req.valid('json').repoGithubIds,
    )
    return c.json(repos)
  })

  app.delete('/github/connection', async (c) => {
    const github = requireGitHub(c)
    if (!github) return unavailable(c)
    await github.installationService.disconnect(param(c, 'workspaceId'))
    return c.body(null, 204)
  })

  // ---- resync -------------------------------------------------------------

  app.post('/github/resync', jsonBody(resyncRequestSchema), async (c) => {
    const github = requireGitHub(c)
    if (!github) return unavailable(c)
    const workspaceId = param(c, 'workspaceId')
    const { repoGithubId, full } = c.req.valid('json')

    if (full) {
      const installation = await github.installationService.requireInstallation(workspaceId)
      const workflow = c.env.GITHUB_BACKFILL_WORKFLOW
      if (workflow) {
        await workflow
          .create({
            id: `backfill-${installation.installationId}-${Date.now()}`,
            params: { installationId: installation.installationId },
          })
          .catch(() => {})
        return c.json({ status: 'backfill_started' }, 202)
      }
      await github.syncService.backfillInstallation(installation.installationId)
      return c.json({ status: 'backfilled' })
    }

    // Incremental: a single repo (optionally via the queue) or the whole workspace.
    if (repoGithubId !== undefined) {
      const queue = c.env.GITHUB_SYNC_QUEUE
      if (queue) {
        await queue.send({ kind: 'resync-repo', workspaceId, repoGithubId })
        return c.json({ status: 'queued' }, 202)
      }
      await github.syncService.syncRepoById(workspaceId, repoGithubId)
      return c.json({ status: 'synced' })
    }
    await github.syncService.resyncWorkspace(workspaceId)
    return c.json({ status: 'synced' })
  })

  // ---- projection reads ---------------------------------------------------

  app.get('/github/repos', async (c) => {
    const github = requireGitHub(c)
    if (!github) return unavailable(c)
    return c.json(await github.service.listRepos(param(c, 'workspaceId')))
  })

  app.get('/github/repos/:repoGithubId/branches', async (c) => {
    const github = requireGitHub(c)
    if (!github) return unavailable(c)
    return c.json(
      await github.service.listBranches(param(c, 'workspaceId'), Number(param(c, 'repoGithubId'))),
    )
  })

  app.get('/github/pulls', async (c) => {
    const github = requireGitHub(c)
    if (!github) return unavailable(c)
    return c.json(await github.service.listPullRequests(param(c, 'workspaceId')))
  })

  app.get('/github/issues', async (c) => {
    const github = requireGitHub(c)
    if (!github) return unavailable(c)
    return c.json(await github.service.listIssues(param(c, 'workspaceId')))
  })

  // ---- writes -------------------------------------------------------------

  // Programmatically create a repository under the connected account (privileged
  // App tier, ADR 0005). Backs the bootstrap modal's "Create repository" button
  // for privileged orgs; restricted orgs never call this (the button opens
  // GitHub's new-repo page client-side instead). 503 when no privileged App is
  // configured; 409 when the account isn't actually privileged (the App isn't
  // installed there or lacks the grant), so the caller can fall back.
  app.post('/github/repos', jsonBody(createRepoRequestSchema), async (c) => {
    const github = requireGitHub(c)
    if (!github) return unavailable(c)
    if (!github.provisioningService) {
      return c.json(
        { error: { code: 'unavailable', message: 'Direct repo creation is not configured' } },
        503,
      )
    }
    const workspaceId = param(c, 'workspaceId')
    const { name, private: isPrivate, description } = c.req.valid('json')
    // Owner = the connected installation's account (throws 409 when unconnected).
    const installation = await github.installationService.requireInstallation(workspaceId)
    const result = await github.provisioningService.provision({
      org: installation.accountLogin,
      name,
      private: isPrivate,
      description,
    })
    if (result.status === 'delegated') {
      return c.json(
        {
          error: {
            code: 'not_privileged',
            message: `cat-factory can't create repositories under ${installation.accountLogin} (${result.reason}).`,
          },
        },
        409,
      )
    }
    return c.json(result.repo, 201)
  })

  app.post('/github/repos/:repoGithubId/branches', jsonBody(createBranchSchema), async (c) => {
    const github = requireGitHub(c)
    if (!github) return unavailable(c)
    const body = c.req.valid('json')
    const branch = await github.service.createBranch(
      param(c, 'workspaceId'),
      Number(param(c, 'repoGithubId')),
      body.name,
      body.fromSha,
    )
    return c.json(branch, 201)
  })

  app.post('/github/repos/:repoGithubId/commits', jsonBody(commitFilesSchema), async (c) => {
    const github = requireGitHub(c)
    if (!github) return unavailable(c)
    const result = await github.service.commitFiles(
      param(c, 'workspaceId'),
      Number(param(c, 'repoGithubId')),
      c.req.valid('json'),
    )
    return c.json(result, 201)
  })

  app.post('/github/repos/:repoGithubId/pulls', jsonBody(openPullRequestSchema), async (c) => {
    const github = requireGitHub(c)
    if (!github) return unavailable(c)
    const pr = await github.service.openPullRequest(
      param(c, 'workspaceId'),
      Number(param(c, 'repoGithubId')),
      c.req.valid('json'),
    )
    return c.json(pr, 201)
  })

  app.put(
    '/github/repos/:repoGithubId/pulls/:number/merge',
    jsonBody(mergePullRequestSchema),
    async (c) => {
      const github = requireGitHub(c)
      if (!github) return unavailable(c)
      await github.service.mergePullRequest(
        param(c, 'workspaceId'),
        Number(param(c, 'repoGithubId')),
        Number(param(c, 'number')),
        c.req.valid('json'),
      )
      return c.body(null, 204)
    },
  )

  app.post(
    '/github/repos/:repoGithubId/issues/:number/comments',
    jsonBody(commentSchema),
    async (c) => {
      const github = requireGitHub(c)
      if (!github) return unavailable(c)
      await github.service.comment(
        param(c, 'workspaceId'),
        Number(param(c, 'repoGithubId')),
        Number(param(c, 'number')),
        c.req.valid('json').body,
      )
      return c.body(null, 204)
    },
  )

  return app
}
