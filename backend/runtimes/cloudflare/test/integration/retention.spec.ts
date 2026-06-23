import type { Clock } from '@cat-factory/kernel'
import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { CryptoIdGenerator } from '../../src/infrastructure/runtime'
import { D1CommitProjectionRepository } from '../../src/infrastructure/repositories/D1CommitProjectionRepository'
import { D1LlmCallMetricRepository } from '../../src/infrastructure/repositories/D1LlmCallMetricRepository'
import { D1RateLimitRepository } from '../../src/infrastructure/repositories/D1RateLimitRepository'
import { D1TokenUsageRepository } from '../../src/infrastructure/repositories/D1TokenUsageRepository'
import { sweepRetention } from '../../src/infrastructure/workflows/retention'

// Retention sweep against the real local D1. Each test seeds one "old" row past
// the window and one "fresh" row inside it, runs the sweep, and asserts only the
// old row is reclaimed. Timestamps are pinned via a fake clock so the assertions
// don't drift with wall-clock time.

const NOW = 1_700_000_000_000
const DAY = 24 * 60 * 60 * 1000
const clock: Clock = { now: () => NOW }

const POLICY = {
  tokenUsageMs: 395 * DAY,
  rateLimitMs: 7 * DAY,
  commitMs: 90 * DAY,
  llmCallMetricsMs: 3 * DAY,
}

function deps() {
  const db = env.DB
  return {
    tokenUsageRepository: new D1TokenUsageRepository({ db }),
    rateLimitRepository: new D1RateLimitRepository({ db, idGenerator: new CryptoIdGenerator() }),
    commitRepository: new D1CommitProjectionRepository({ db }),
    llmCallMetricRepository: new D1LlmCallMetricRepository({ db }),
    clock,
    policy: POLICY,
  }
}

function llmMetric(id: string, createdAt: number, ws: string) {
  return {
    id,
    workspaceId: ws,
    executionId: 'exec',
    agentKind: 'coder',
    provider: 'workers-ai',
    model: 'm',
    createdAt,
    streaming: false,
    messageCount: 1,
    toolCount: 0,
    requestMaxTokens: 1000,
    promptTokens: 10,
    cachedPromptTokens: 0,
    completionTokens: 5,
    totalTokens: 15,
    finishReason: 'stop',
    upstreamMs: 100,
    overheadMs: 10,
    totalMs: 110,
    ok: true,
    httpStatus: 200,
    errorMessage: null,
    promptText: '[]',
    promptPrefixCount: 0,
    promptHash: '',
    responseText: 'ok',
    reasoningText: '',
  }
}

async function countRows(table: string, where: string, ...binds: unknown[]): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`)
    .bind(...binds)
    .first<{ n: number }>()
  return row?.n ?? 0
}

describe('storage retention sweep', () => {
  it('prunes token_usage rows past the window but keeps fresh ones', async () => {
    const ws = 'ws_retention_tok'
    const repo = new D1TokenUsageRepository({ db: env.DB })
    const base = {
      workspaceId: ws,
      executionId: null,
      agentKind: 'architect',
      provider: 'openai',
      model: 'gpt',
      inputTokens: 1,
      outputTokens: 1,
      costEstimate: 0,
    }
    await repo.record({ ...base, id: 'tok_old', createdAt: NOW - 400 * DAY })
    await repo.record({ ...base, id: 'tok_fresh', createdAt: NOW - 1 * DAY })

    const result = await sweepRetention(deps())

    expect(result.tokenUsage).toBeGreaterThanOrEqual(1)
    expect(await countRows('token_usage', 'id = ?', 'tok_old')).toBe(0)
    expect(await countRows('token_usage', 'id = ?', 'tok_fresh')).toBe(1)
  })

  it('prunes github_rate_limits telemetry past the 7-day window', async () => {
    const repo = new D1RateLimitRepository({ db: env.DB, idGenerator: new CryptoIdGenerator() })
    const installationId = 987_654_321
    await repo.record({
      installationId,
      resource: 'core',
      limit: 5000,
      remaining: 4999,
      resetAt: NOW,
      observedAt: NOW - 30 * DAY,
    })
    await repo.record({
      installationId,
      resource: 'core',
      limit: 5000,
      remaining: 4998,
      resetAt: NOW,
      observedAt: NOW - 1 * DAY,
    })

    const result = await sweepRetention(deps())

    expect(result.rateLimits).toBeGreaterThanOrEqual(1)
    expect(
      await countRows(
        'github_rate_limits',
        'installation_id = ? AND observed_at < ?',
        installationId,
        NOW - 7 * DAY,
      ),
    ).toBe(0)
    expect(await countRows('github_rate_limits', 'installation_id = ?', installationId)).toBe(1)
  })

  it('prunes commits authored past the window, keeping recent and null-dated rows', async () => {
    const ws = 'ws_retention_commits'
    const repo = new D1CommitProjectionRepository({ db: env.DB })
    await repo.upsertMany(ws, [
      {
        repoGithubId: 1,
        sha: 'old',
        message: 'm',
        author: 'a',
        authoredAt: NOW - 200 * DAY,
        syncedAt: NOW,
      },
      {
        repoGithubId: 1,
        sha: 'recent',
        message: 'm',
        author: 'a',
        authoredAt: NOW - 5 * DAY,
        syncedAt: NOW,
      },
      {
        repoGithubId: 1,
        sha: 'undated',
        message: 'm',
        author: 'a',
        authoredAt: null,
        syncedAt: NOW,
      },
    ])

    const result = await sweepRetention(deps())

    expect(result.commits).toBeGreaterThanOrEqual(1)
    const remaining = await repo.listByRepo(ws, 1)
    expect(remaining.map((c) => c.sha).sort()).toEqual(['recent', 'undated'])
  })

  it('prunes llm_call_metrics past the 3-day window but keeps fresh ones', async () => {
    const ws = 'ws_retention_llm'
    const repo = new D1LlmCallMetricRepository({ db: env.DB })
    await repo.record(llmMetric('llm_old', NOW - 10 * DAY, ws))
    await repo.record(llmMetric('llm_fresh', NOW - 1 * DAY, ws))

    const result = await sweepRetention(deps())

    expect(result.llmCallMetrics).toBeGreaterThanOrEqual(1)
    expect(await countRows('llm_call_metrics', 'id = ?', 'llm_old')).toBe(0)
    expect(await countRows('llm_call_metrics', 'id = ?', 'llm_fresh')).toBe(1)
  })

  it('treats a zero window as "disabled" and prunes nothing', async () => {
    const ws = 'ws_retention_disabled'
    const repo = new D1TokenUsageRepository({ db: env.DB })
    await repo.record({
      id: 'tok_disabled',
      workspaceId: ws,
      executionId: null,
      agentKind: 'architect',
      provider: 'openai',
      model: 'gpt',
      inputTokens: 1,
      outputTokens: 1,
      costEstimate: 0,
      createdAt: NOW - 1000 * DAY,
    })

    const result = await sweepRetention({
      ...deps(),
      policy: { tokenUsageMs: 0, rateLimitMs: 0, commitMs: 0, llmCallMetricsMs: 0 },
    })

    expect(result).toEqual({
      tokenUsage: 0,
      rateLimits: 0,
      commits: 0,
      llmCallMetrics: 0,
      scheduleRuns: 0,
    })
    expect(await countRows('token_usage', 'id = ?', 'tok_disabled')).toBe(1)
  })
})

describe('commit projection bulk upsert', () => {
  it('persists a batch larger than the chunk size', async () => {
    const ws = 'ws_commit_chunk'
    const repo = new D1CommitProjectionRepository({ db: env.DB })
    const commits = Array.from({ length: 120 }, (_, i) => ({
      repoGithubId: 42,
      sha: `sha-${i}`,
      message: `commit ${i}`,
      author: 'dev',
      authoredAt: NOW - i * 1000,
      syncedAt: NOW,
    }))

    await repo.upsertMany(ws, commits)

    const stored = await repo.listByRepo(ws, 42, 1000)
    expect(stored).toHaveLength(120)
  })
})
