import type { PgBoss } from 'pg-boss'
import { describe, expect, it } from 'vitest'
import { PgBossGuidedReviewRunner } from '../src/execution/guidedReviewRunner.js'

const QUEUE_OPTIONS = {
  expireInSeconds: 900,
  heartbeatSeconds: 30,
  retryLimit: 3,
  retryDelaySeconds: 5,
}

describe('PgBossGuidedReviewRunner', () => {
  it('keys each job on its job key, so the exclusive queue holds one live delivery per job', async () => {
    const sent: { queue: string; data: unknown; options: Record<string, unknown> }[] = []
    const boss = {
      send: async (queue: string, data: unknown, options: Record<string, unknown>) => {
        sent.push({ queue, data, options })
        return 'job-id'
      },
    } as unknown as PgBoss
    const runner = new PgBossGuidedReviewRunner(boss, QUEUE_OPTIONS)

    await runner.start('ws_1', { kind: 'message', messageId: 'grm_1' })
    await runner.start('ws_1', { kind: 'overview', sessionId: 'grs_1', generation: 3 })

    expect(sent.map((s) => [s.queue, s.options.singletonKey])).toEqual([
      ['guided-review.run', 'grm-grm_1'],
      ['guided-review.run', 'gro-grs_1-3'],
    ])
    expect(sent[0]?.data).toEqual({
      workspaceId: 'ws_1',
      job: { kind: 'message', messageId: 'grm_1' },
    })
  })
})
