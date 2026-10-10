import { describe, expect, it } from 'vitest'
import type { Block, ExecutionInstance, ExecutionStatus } from '@cat-factory/kernel'
import type { CoreDependencies } from '../container.js'
import { resolveBlockRunContext } from './blockRunContext.js'

// `block.executionId` is the block's LAST run, not necessarily a live one — nothing clears it when
// a run settles, because the board reads it to show the run a task last had. Two consumers read
// the resolved scope and a stale id hurts both: a per-run personal activation is cleared at
// terminal so the lease can only fail, and the inline telemetry wrap falls back to
// `scope.executionId`, which would file a call's spend into a FINISHED run's rollup. So the
// execution id is dropped for a settled run while the INITIATOR — a durable fact the API-key pool
// and the user's local endpoints scope by — is kept.

const block = (executionId: string | null): Block =>
  ({ id: 'blk_1', workspaceId: 'ws_1', executionId }) as unknown as Block

const instance = (status: ExecutionStatus, initiatedBy?: string): ExecutionInstance =>
  ({
    id: 'exec_1',
    status,
    ...(initiatedBy ? { initiatedBy } : {}),
  }) as unknown as ExecutionInstance

function resolverFor(run: ExecutionInstance | null) {
  const deps = {
    executionRepository: { get: () => Promise.resolve(run) },
  } as unknown as CoreDependencies
  return resolveBlockRunContext(deps)
}

describe('resolveBlockRunContext', () => {
  it('carries the run for every LIVE status, parked ones included', async () => {
    // A `blocked` (human decision) or `paused` (spend) run is exactly when an inline reviewer or
    // interviewer runs, so excluding either would strip the run from the calls that need it most.
    for (const status of ['running', 'blocked', 'paused'] as const) {
      const resolved = await resolverFor(instance(status, 'usr_1'))('ws_1', block('exec_1'))
      expect(resolved).toEqual({ executionId: 'exec_1', userId: 'usr_1' })
    }
  })

  it('drops the run once it has SETTLED, but keeps the initiator', async () => {
    for (const status of ['done', 'failed'] as const) {
      const resolved = await resolverFor(instance(status, 'usr_1'))('ws_1', block('exec_1'))
      expect(resolved).toEqual({ userId: 'usr_1' })
    }
  })

  it('drops the run when the instance is gone (a pruned or foreign id)', async () => {
    expect(await resolverFor(null)('ws_1', block('exec_1'))).toEqual({})
  })

  it('reads nothing for a block that has never run', async () => {
    expect(await resolverFor(instance('running', 'usr_1'))('ws_1', block(null))).toEqual({})
  })
})
