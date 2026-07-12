import type { GitHubModule } from '@cat-factory/orchestration'
import type { Logger, ServerContainer } from '@cat-factory/server'
import type { Job, PgBoss } from 'pg-boss'
import { describe, expect, it, vi } from 'vitest'
import { createNodeGateways } from '../src/gateways.js'
import {
  type GitHubSyncJob,
  GITHUB_SYNC_QUEUE,
  applyGitHubSyncJob,
  startGitHubSyncWorker,
} from '../src/execution/githubSyncRunner.js'

// Async GitHub ingest on Node (item 5 of the system-audit initiative): proves the gateway
// seams enqueue onto the pg-boss `github.sync` queue when a boss is wired (so the request
// acks fast) and fall back to the inline "not enabled" path when it isn't, and that the
// worker applies each job kind to the SAME GitHubSyncService/WebhookService the inline path
// used — the Node analogue of the Worker's GITHUB_SYNC_QUEUE consumer + GitHubBackfillWorkflow.

const noopLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as Logger

/** A fake pg-boss capturing every `send` and the handler registered via `work`. */
function fakeBoss() {
  const sends: { name: string; data: unknown }[] = []
  let handler: ((jobs: Job<GitHubSyncJob>[]) => Promise<void>) | undefined
  const boss = {
    send: async (name: string, data: unknown) => {
      sends.push({ name, data })
      return 'job-id'
    },
    createQueue: async () => {},
    work: async (_name: string, _opts: unknown, fn: typeof handler) => {
      handler = fn
      return 'worker-id'
    },
  } as unknown as PgBoss
  return {
    boss,
    sends,
    /** Run a job through the registered worker handler. */
    run: (job: GitHubSyncJob) => {
      if (!handler) throw new Error('worker not started')
      return handler([{ data: job } as Job<GitHubSyncJob>])
    },
  }
}

/** A GitHub module recording which sync/webhook methods were applied. */
function fakeGitHub() {
  const calls: string[] = []
  const github = {
    webhookService: {
      handle: async (eventName: string, _payload: unknown) => {
        calls.push(`webhook:${eventName}`)
      },
    },
    syncService: {
      syncRepoById: async (workspaceId: string, repoGithubId: number) => {
        calls.push(`resync:${workspaceId}:${repoGithubId}`)
      },
      backfillInstallation: async (installationId: number) => {
        calls.push(`backfill:${installationId}`)
      },
    },
  } as unknown as GitHubModule
  return { github, calls }
}

describe('createNodeGateways async GitHub ingest', () => {
  it('enqueues webhook / resync / backfill onto the queue and returns true when a boss is wired', async () => {
    const { boss, sends } = fakeBoss()
    const gw = createNodeGateways(process.env, boss)

    await expect(gw.githubWebhook.enqueueWebhook('push', { a: 1 })).resolves.toBe(true)
    await expect(gw.githubWebhook.queueRepoResync('ws-1', 42)).resolves.toBe(true)
    await expect(gw.githubBackfill.scheduleBackfill(99)).resolves.toBe(true)

    expect(sends.map((s) => s.name)).toEqual([
      GITHUB_SYNC_QUEUE,
      GITHUB_SYNC_QUEUE,
      GITHUB_SYNC_QUEUE,
    ])
    expect(sends.map((s) => s.data)).toEqual([
      { kind: 'webhook', eventName: 'push', payload: { a: 1 } },
      { kind: 'resync-repo', workspaceId: 'ws-1', repoGithubId: 42 },
      { kind: 'backfill', installationId: 99 },
    ])
  })

  it('reports "not enabled" (false) so the caller runs inline when no boss is wired', async () => {
    const gw = createNodeGateways(process.env)
    await expect(gw.githubWebhook.enqueueWebhook('push', {})).resolves.toBe(false)
    await expect(gw.githubWebhook.queueRepoResync('ws-1', 42)).resolves.toBe(false)
    await expect(gw.githubBackfill.scheduleBackfill(99)).resolves.toBe(false)
  })
})

describe('applyGitHubSyncJob', () => {
  it('routes each kind to the matching sync/webhook service method', async () => {
    const { github, calls } = fakeGitHub()
    await applyGitHubSyncJob(github, { kind: 'webhook', eventName: 'pull_request', payload: {} })
    await applyGitHubSyncJob(github, { kind: 'resync-repo', workspaceId: 'ws-2', repoGithubId: 7 })
    await applyGitHubSyncJob(github, { kind: 'backfill', installationId: 5 })
    expect(calls).toEqual(['webhook:pull_request', 'resync:ws-2:7', 'backfill:5'])
  })
})

describe('startGitHubSyncWorker', () => {
  it('applies a dequeued job to the GitHub module', async () => {
    const { boss, run } = fakeBoss()
    const { github, calls } = fakeGitHub()
    await startGitHubSyncWorker(boss, { github } as unknown as ServerContainer, noopLog)

    await run({ kind: 'resync-repo', workspaceId: 'ws-3', repoGithubId: 11 })
    expect(calls).toEqual(['resync:ws-3:11'])
  })

  it('drops a job without retrying when the GitHub module is unwired', async () => {
    const { boss, run } = fakeBoss()
    await startGitHubSyncWorker(boss, {} as unknown as ServerContainer, noopLog)
    // No github module → the handler completes (no throw), so pg-boss does not retry.
    await expect(run({ kind: 'webhook', eventName: 'push', payload: {} })).resolves.toBeUndefined()
  })

  it('rethrows an apply failure so pg-boss retries the job', async () => {
    const { boss, run } = fakeBoss()
    const github = {
      webhookService: { handle: async () => Promise.reject(new Error('boom')) },
      syncService: {},
    } as unknown as GitHubModule
    const error = vi.fn()
    const log = { info: () => {}, warn: () => {}, error } as unknown as Logger
    await startGitHubSyncWorker(boss, { github } as unknown as ServerContainer, log)

    await expect(run({ kind: 'webhook', eventName: 'push', payload: {} })).rejects.toThrow('boom')
    expect(error).toHaveBeenCalledOnce()
  })
})
