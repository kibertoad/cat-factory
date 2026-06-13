import {
  commentSchema,
  commitFilesSchema,
  createBranchSchema,
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
    const state = await signer.sign(param(c, 'workspaceId'))
    const url = `https://github.com/apps/${config.appSlug}/installations/new?state=${encodeURIComponent(state)}`
    return c.json({ url })
  })

  app.get('/github/connection', async (c) => {
    const github = requireGitHub(c)
    if (!github) return unavailable(c)
    const connection = await github.installationService.getConnection(param(c, 'workspaceId'))
    return c.json({ connection })
  })

  // Programmatic bind (the browser flow uses /github/setup/callback instead).
  app.post('/github/connect', jsonBody(connectSchema), async (c) => {
    const github = requireGitHub(c)
    if (!github) return unavailable(c)
    const connection = await github.installationService.connect(
      param(c, 'workspaceId'),
      c.req.valid('json').installationId,
    )
    return c.json(connection, 201)
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
