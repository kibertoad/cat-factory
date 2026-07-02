import {
  commentGitHubIssueContract,
  commitGitHubFilesContract,
  connectGitHubContract,
  createGitHubBranchContract,
  createGitHubRepoContract,
  disconnectGitHubContract,
  getGitHubConnectionContract,
  getGitHubInstallUrlContract,
  listGitHubAvailableReposContract,
  listGitHubBranchesContract,
  listGitHubInstallationsContract,
  listGitHubIssuesContract,
  listGitHubPullsContract,
  listGitHubReposContract,
  listGitHubRepoTreeContract,
  mergeGitHubPullRequestContract,
  openGitHubPullRequestContract,
  resyncGitHubContract,
  setGitHubLinkedReposContract,
  setGitHubRepoMonorepoContract,
} from '@cat-factory/contracts'
import type { GitHubModule } from '@cat-factory/orchestration'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { StateSigner } from '../../github/state.js'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'

/** Resolve the GitHub module or send a 503, returning null when unconfigured. */
function requireGitHub<E extends AppEnv>(c: Context<E>): GitHubModule | null {
  return c.get('container').github ?? null
}

const unavailable = <E extends AppEnv>(c: Context<E>) =>
  c.json({ error: { code: 'unavailable', message: 'GitHub integration is not configured' } }, 503)

/**
 * Workspace-scoped GitHub endpoints: connection management, projection reads
 * (served from the local DB — fast and rate-limit-free), resync triggers, and repo
 * writes. Mounted under `/workspaces/:workspaceId`. Runtime-neutral: the async resync
 * paths (full backfill, single-repo resync) are delegated to the facade's GitHub
 * gateways, which schedule out of band (Cloudflare Workflow/Queue or pg-boss) or
 * report that the caller should run them inline.
 */
export function githubController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // ---- connection ---------------------------------------------------------

  // The URL the frontend should redirect to so a workspace owner can install
  // the App; carries an HMAC-signed `state` binding the install to this workspace.
  buildHonoRoute(app, getGitHubInstallUrlContract, async (c) => {
    const github = requireGitHub(c)
    if (!github) return unavailable(c)
    const config = c.get('container').config.github
    const signer = new StateSigner(config.webhookSecret)
    // Bind the install to this workspace AND the signed-in user, with a short
    // expiry. (The per-workspace authorization middleware has already confirmed
    // the caller owns :workspaceId before this handler runs.)
    const state = await signer.sign({
      workspaceId: param(c, 'workspaceId'),
      userId: c.get('user')?.id ?? null,
      exp: Date.now() + 10 * 60 * 1000,
    })
    const url = `https://github.com/apps/${config.appSlug}/installations/new?state=${encodeURIComponent(state)}`
    return c.json({ url }, 200)
  })

  buildHonoRoute(app, getGitHubConnectionContract, async (c) => {
    const github = requireGitHub(c)
    if (!github) return unavailable(c)
    const connection = await github.installationService.getConnection(param(c, 'workspaceId'))
    return c.json({ connection }, 200)
  })

  // Discover the App's installations so the UI can offer a pick instead of a
  // manually typed installation id (the caller already owns :workspaceId).
  buildHonoRoute(app, listGitHubInstallationsContract, async (c) => {
    const github = requireGitHub(c)
    if (!github) return unavailable(c)
    const installations = await github.installationService.listAvailableInstallations(
      param(c, 'workspaceId'),
    )
    return c.json({ installations }, 200)
  })

  // Programmatic bind (the browser flow uses /github/setup/callback instead).
  // Used by the "discover & link" picker and connect-by-id. Binds the installation
  // to the workspace's account; repos are then linked explicitly (see below), so
  // there is no whole-installation backfill on connect.
  buildHonoRoute(app, connectGitHubContract, async (c) => {
    const github = requireGitHub(c)
    if (!github) return unavailable(c)
    const workspaceId = param(c, 'workspaceId')
    const { installationId } = c.req.valid('json')
    const connection = await github.installationService.connect(workspaceId, installationId)
    return c.json(connection, 201)
  })

  // The repos the connected installation can access, annotated with whether this
  // workspace links each. Drives the per-workspace repo picker.
  buildHonoRoute(app, listGitHubAvailableReposContract, async (c) => {
    const github = requireGitHub(c)
    if (!github) return unavailable(c)
    return c.json(
      await github.syncService.listAvailableRepos(param(c, 'workspaceId'), {
        q: c.req.valid('query').q,
      }),
      200,
    )
  })

  // Set the exact set of repos this workspace links. Projects the selection,
  // tombstones the rest, and deep-syncs the linked repos.
  buildHonoRoute(app, setGitHubLinkedReposContract, async (c) => {
    const github = requireGitHub(c)
    if (!github) return unavailable(c)
    const repos = await github.syncService.setLinkedRepos(
      param(c, 'workspaceId'),
      c.req.valid('json').repoGithubIds,
    )
    return c.json(repos, 200)
  })

  // Flag (or unflag) a linked repo as a monorepo: the board then lets several service
  // frames target the same repo, each pinned to a subdirectory (the picker below).
  buildHonoRoute(app, setGitHubRepoMonorepoContract, async (c) => {
    const github = requireGitHub(c)
    if (!github) return unavailable(c)
    const repo = await github.syncService.setRepoMonorepo(
      param(c, 'workspaceId'),
      Number(c.req.valid('param').repoGithubId),
      c.req.valid('json').isMonorepo,
    )
    return c.json(repo, 200)
  })

  // Browse one level of a (monorepo) repo's tree so the service picker can pin a
  // service to a subdirectory. `path` ('' = root) is the directory to list.
  buildHonoRoute(app, listGitHubRepoTreeContract, async (c) => {
    const github = requireGitHub(c)
    if (!github) return unavailable(c)
    return c.json(
      await github.syncService.listRepoDirectory(
        param(c, 'workspaceId'),
        Number(c.req.valid('param').repoGithubId),
        c.req.valid('query').path ?? '',
      ),
      200,
    )
  })

  buildHonoRoute(app, disconnectGitHubContract, async (c) => {
    const github = requireGitHub(c)
    if (!github) return unavailable(c)
    await github.installationService.disconnect(param(c, 'workspaceId'))
    return c.body(null, 204)
  })

  // ---- resync -------------------------------------------------------------

  buildHonoRoute(app, resyncGitHubContract, async (c) => {
    const github = requireGitHub(c)
    if (!github) return unavailable(c)
    const workspaceId = param(c, 'workspaceId')
    const { repoGithubId, full } = c.req.valid('json')
    const { gateways } = c.get('container')

    if (full) {
      const installation = await github.installationService.requireInstallation(workspaceId)
      const scheduled = await gateways.githubBackfill.scheduleBackfill(installation.installationId)
      if (scheduled) return c.json({ status: 'backfill_started' }, 202)
      await github.syncService.backfillInstallation(installation.installationId)
      return c.json({ status: 'backfilled' }, 200)
    }

    // Incremental: a single repo (optionally out of band) or the whole workspace.
    if (repoGithubId !== undefined) {
      const queued = await gateways.githubWebhook.queueRepoResync(workspaceId, repoGithubId)
      if (queued) return c.json({ status: 'queued' }, 202)
      await github.syncService.syncRepoById(workspaceId, repoGithubId)
      return c.json({ status: 'synced' }, 200)
    }
    await github.syncService.resyncWorkspace(workspaceId)
    return c.json({ status: 'synced' }, 200)
  })

  // ---- projection reads ---------------------------------------------------

  buildHonoRoute(app, listGitHubReposContract, async (c) => {
    const github = requireGitHub(c)
    if (!github) return unavailable(c)
    return c.json(await github.service.listRepos(param(c, 'workspaceId')), 200)
  })

  buildHonoRoute(app, listGitHubBranchesContract, async (c) => {
    const github = requireGitHub(c)
    if (!github) return unavailable(c)
    return c.json(
      await github.service.listBranches(
        param(c, 'workspaceId'),
        Number(c.req.valid('param').repoGithubId),
      ),
      200,
    )
  })

  buildHonoRoute(app, listGitHubPullsContract, async (c) => {
    const github = requireGitHub(c)
    if (!github) return unavailable(c)
    return c.json(await github.service.listPullRequests(param(c, 'workspaceId')), 200)
  })

  buildHonoRoute(app, listGitHubIssuesContract, async (c) => {
    const github = requireGitHub(c)
    if (!github) return unavailable(c)
    return c.json(await github.service.listIssues(param(c, 'workspaceId')), 200)
  })

  // ---- writes -------------------------------------------------------------

  // Programmatically create a repository under the connected account (privileged
  // App tier, ADR 0005). 503 when no privileged App is configured; 409 when the
  // account isn't actually privileged, so the caller can fall back.
  buildHonoRoute(app, createGitHubRepoContract, async (c) => {
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
    const result = await github.provisioningService.provision(installation.installationId, {
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

  buildHonoRoute(app, createGitHubBranchContract, async (c) => {
    const github = requireGitHub(c)
    if (!github) return unavailable(c)
    const body = c.req.valid('json')
    const branch = await github.service.createBranch(
      param(c, 'workspaceId'),
      Number(c.req.valid('param').repoGithubId),
      body.name,
      body.fromSha,
    )
    return c.json(branch, 201)
  })

  buildHonoRoute(app, commitGitHubFilesContract, async (c) => {
    const github = requireGitHub(c)
    if (!github) return unavailable(c)
    const result = await github.service.commitFiles(
      param(c, 'workspaceId'),
      Number(c.req.valid('param').repoGithubId),
      c.req.valid('json'),
    )
    return c.json(result, 201)
  })

  buildHonoRoute(app, openGitHubPullRequestContract, async (c) => {
    const github = requireGitHub(c)
    if (!github) return unavailable(c)
    const pr = await github.service.openPullRequest(
      param(c, 'workspaceId'),
      Number(c.req.valid('param').repoGithubId),
      c.req.valid('json'),
    )
    return c.json(pr, 201)
  })

  buildHonoRoute(app, mergeGitHubPullRequestContract, async (c) => {
    const github = requireGitHub(c)
    if (!github) return unavailable(c)
    const params = c.req.valid('param')
    await github.service.mergePullRequest(
      param(c, 'workspaceId'),
      Number(params.repoGithubId),
      Number(params.number),
      c.req.valid('json'),
    )
    return c.body(null, 204)
  })

  buildHonoRoute(app, commentGitHubIssueContract, async (c) => {
    const github = requireGitHub(c)
    if (!github) return unavailable(c)
    const params = c.req.valid('param')
    await github.service.comment(
      param(c, 'workspaceId'),
      Number(params.repoGithubId),
      Number(params.number),
      c.req.valid('json').body,
    )
    return c.body(null, 204)
  })

  return app
}
