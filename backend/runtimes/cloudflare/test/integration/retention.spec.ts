import type { Clock } from '@cat-factory/kernel'
import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { CryptoIdGenerator } from '../../src/infrastructure/runtime'
import { D1AgentContextSnapshotRepository } from '../../src/infrastructure/repositories/D1AgentContextSnapshotRepository'
import { D1AgentSearchQueryRepository } from '../../src/infrastructure/repositories/D1AgentSearchQueryRepository'
import { D1CommitProjectionRepository } from '../../src/infrastructure/repositories/D1CommitProjectionRepository'
import { D1LlmCallMetricRepository } from '../../src/infrastructure/repositories/D1LlmCallMetricRepository'
import { D1NotificationRepository } from '../../src/infrastructure/repositories/D1NotificationRepository'
import { D1RateLimitRepository } from '../../src/infrastructure/repositories/D1RateLimitRepository'
import { D1SubscriptionQuotaCycleRepository } from '../../src/infrastructure/repositories/D1SubscriptionQuotaCycleRepository'
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
  provisioningLogMs: 14 * DAY,
  notificationsMs: 90 * DAY,
}

function deps() {
  const db = env.DB
  // Telemetry (llm_call_metrics + agent_context_snapshots) lives in the dedicated
  // TELEMETRY_DB database, not the main DB.
  const telemetryDb = env.TELEMETRY_DB
  return {
    tokenUsageRepository: new D1TokenUsageRepository({ db }),
    rateLimitRepository: new D1RateLimitRepository({ db, idGenerator: new CryptoIdGenerator() }),
    commitRepository: new D1CommitProjectionRepository({ db }),
    llmCallMetricRepository: new D1LlmCallMetricRepository({ db: telemetryDb }),
    agentContextSnapshotRepository: new D1AgentContextSnapshotRepository({ db: telemetryDb }),
    agentSearchQueryRepository: new D1AgentSearchQueryRepository({ db: telemetryDb }),
    // Subscription quota-cycle counters live in the main DB (migration 0047).
    subscriptionQuotaCycleRepository: new D1SubscriptionQuotaCycleRepository({ db }),
    notificationRepository: new D1NotificationRepository({ db }),
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

// Telemetry tables live in the dedicated TELEMETRY_DB, so count against it.
async function countTelemetryRows(
  table: string,
  where: string,
  ...binds: unknown[]
): Promise<number> {
  const row = await env.TELEMETRY_DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`)
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
      accountId: null,
      userId: null,
      executionId: null,
      agentKind: 'architect',
      provider: 'openai',
      model: 'gpt',
      inputTokens: 1,
      outputTokens: 1,
      costEstimate: 0,
      billing: 'metered' as const,
      vendor: null,
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
    const repo = new D1LlmCallMetricRepository({ db: env.TELEMETRY_DB })
    await repo.record(llmMetric('llm_old', NOW - 10 * DAY, ws))
    await repo.record(llmMetric('llm_fresh', NOW - 1 * DAY, ws))

    const result = await sweepRetention(deps())

    expect(result.llmCallMetrics).toBeGreaterThanOrEqual(1)
    expect(await countTelemetryRows('llm_call_metrics', 'id = ?', 'llm_old')).toBe(0)
    expect(await countTelemetryRows('llm_call_metrics', 'id = ?', 'llm_fresh')).toBe(1)
  })

  it('treats a zero window as "disabled" and prunes nothing', async () => {
    const ws = 'ws_retention_disabled'
    const repo = new D1TokenUsageRepository({ db: env.DB })
    await repo.record({
      id: 'tok_disabled',
      workspaceId: ws,
      accountId: null,
      userId: null,
      executionId: null,
      agentKind: 'architect',
      provider: 'openai',
      model: 'gpt',
      inputTokens: 1,
      outputTokens: 1,
      costEstimate: 0,
      billing: 'metered',
      vendor: null,
      createdAt: NOW - 1000 * DAY,
    })

    const result = await sweepRetention({
      ...deps(),
      policy: {
        tokenUsageMs: 0,
        rateLimitMs: 0,
        commitMs: 0,
        llmCallMetricsMs: 0,
        provisioningLogMs: 0,
        notificationsMs: 0,
      },
    })

    expect(result).toEqual({
      tokenUsage: 0,
      rateLimits: 0,
      commits: 0,
      llmCallMetrics: 0,
      agentContextSnapshots: 0,
      agentSearchQueries: 0,
      // The quota-cycle prune uses a FIXED 30-day window, not the policy — but no
      // quota rows are seeded here, so it reclaims nothing.
      subscriptionQuotaCycles: 0,
      scheduleRuns: 0,
      provisioningLog: 0,
      passwordResetTokens: 0,
      notifications: 0,
    })
    expect(await countRows('token_usage', 'id = ?', 'tok_disabled')).toBe(1)
  })

  it('prunes idle subscription_quota_cycles past the fixed 30-day window but keeps fresh ones', async () => {
    const repo = new D1SubscriptionQuotaCycleRepository({ db: env.DB })
    const FIVE_H = 5 * 60 * 60 * 1000
    // An idle cycle anchored 40 days ago (well past the 30-day prune window)...
    await repo.recordUsage(
      { id: 'sqc_old', scope: 'user', scopeId: 'u_ret_old', vendor: 'claude', windowKind: '5h' },
      { inputTokens: 1, outputTokens: 1 },
      NOW - 40 * DAY,
      FIVE_H,
    )
    // ...and a fresh one anchored 2 days ago (inside the window).
    await repo.recordUsage(
      { id: 'sqc_new', scope: 'user', scopeId: 'u_ret_new', vendor: 'claude', windowKind: '5h' },
      { inputTokens: 1, outputTokens: 1 },
      NOW - 2 * DAY,
      FIVE_H,
    )

    const result = await sweepRetention(deps())

    expect(result.subscriptionQuotaCycles).toBeGreaterThanOrEqual(1)
    expect(await countRows('subscription_quota_cycles', 'id = ?', 'sqc_old')).toBe(0)
    expect(await countRows('subscription_quota_cycles', 'id = ?', 'sqc_new')).toBe(1)
  })

  it('prunes resolved notifications past the window, keeping open + fresh-resolved ones', async () => {
    const ws = 'ws_retention_notif'
    const repo = new D1NotificationRepository({ db: env.DB })
    const base = {
      type: 'ci_failed' as const,
      severity: 'normal' as const,
      blockId: null,
      executionId: null,
      title: 't',
      body: 'b',
      payload: null,
    }
    // Resolved 100 days ago — past the 90-day window, should be pruned.
    await repo.upsert(ws, {
      ...base,
      id: 'notif_old',
      status: 'acted',
      createdAt: NOW - 120 * DAY,
      resolvedAt: NOW - 100 * DAY,
    })
    // Resolved 2 days ago — inside the window, kept.
    await repo.upsert(ws, {
      ...base,
      id: 'notif_fresh',
      status: 'dismissed',
      createdAt: NOW - 5 * DAY,
      resolvedAt: NOW - 2 * DAY,
    })
    // Still open (never resolved) though ancient — the actionable inbox, never pruned.
    await repo.upsert(ws, {
      ...base,
      id: 'notif_open',
      status: 'open',
      createdAt: NOW - 200 * DAY,
      resolvedAt: null,
    })

    const result = await sweepRetention(deps())

    expect(result.notifications).toBeGreaterThanOrEqual(1)
    expect(await countRows('notifications', 'id = ?', 'notif_old')).toBe(0)
    expect(await countRows('notifications', 'id = ?', 'notif_fresh')).toBe(1)
    expect(await countRows('notifications', 'id = ?', 'notif_open')).toBe(1)
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
