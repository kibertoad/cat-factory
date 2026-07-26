import type {
  Block,
  BlockRepository,
  ExecutionInstance,
  PrVerificationReportPublisher,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { PrVerificationReportController } from './PrVerificationReportController.js'

const BLOCK = {
  id: 'blk_1',
  title: 'Add login',
  level: 'task',
  pullRequest: { number: 7, url: 'https://github.test/o/r/pull/7', branch: 'work' },
} as unknown as Block

function makeInstance(overrides: Partial<ExecutionInstance> = {}): ExecutionInstance {
  return {
    id: 'exec_1',
    blockId: 'blk_1',
    pipelineId: 'pl_quick',
    pipelineName: 'Quick implement',
    steps: [{ agentKind: 'coder', state: 'done', progress: 1, decision: null }],
    currentStep: 0,
    status: 'done',
    ...overrides,
  } as ExecutionInstance
}

function makeDeps(block: Block | null, publisher?: PrVerificationReportPublisher) {
  return {
    blockRepository: { get: async () => block } as unknown as BlockRepository,
    clock: { now: () => 1_700_000_000_000 },
    publisher,
  }
}

/** A publisher that records the sections handed to it. */
function recordingPublisher() {
  const sections: string[] = []
  return {
    sections,
    publisher: {
      publish: async (_ws: string, _block: string, section: string) => {
        sections.push(section)
        return { published: true }
      },
    } satisfies PrVerificationReportPublisher,
  }
}

describe('PrVerificationReportController', () => {
  it('publishes the composed report for a task that has a PR', async () => {
    const { sections, publisher } = recordingPublisher()
    await new PrVerificationReportController(makeDeps(BLOCK, publisher)).publishForRun(
      'ws_1',
      makeInstance(),
    )

    expect(sections).toHaveLength(1)
    expect(sections[0]).toContain('Verification report')
    expect(sections[0]).toContain('exec_1')
  })

  it('is a no-op when no publisher is wired (tests / a no-VCS deployment)', async () => {
    // The pass-through the engine relies on: nothing is read, nothing is written, no throw.
    let reads = 0
    const deps = {
      blockRepository: {
        get: async () => {
          reads += 1
          return BLOCK
        },
      } as unknown as BlockRepository,
      clock: { now: () => 0 },
    }
    await new PrVerificationReportController(deps).publishForRun('ws_1', makeInstance())
    expect(reads).toBe(0)
  })

  it('skips a block with no pull request', async () => {
    const { sections, publisher } = recordingPublisher()
    await new PrVerificationReportController(
      makeDeps({ id: 'blk_1', title: 'x' } as Block, publisher),
    ).publishForRun('ws_1', makeInstance())
    expect(sections).toHaveLength(0)
  })

  it('skips the remote write when the report has not changed', async () => {
    const { sections, publisher } = recordingPublisher()
    const controller = new PrVerificationReportController(makeDeps(BLOCK, publisher))
    const instance = makeInstance()
    await controller.publishForRun('ws_1', instance)
    await controller.publishForRun('ws_1', instance)
    // The second pass composes an identical report (only `generatedAt` could differ, and it is
    // masked out of the fingerprint), so a 12-step run makes one PR edit, not twelve.
    expect(sections).toHaveLength(1)

    // A step settling with new evidence does publish again.
    instance.steps.push({
      agentKind: 'ci',
      state: 'done',
      progress: 1,
      decision: null,
      gate: { phase: 'checking', attempts: 0, maxAttempts: 10, lastVerdict: 'pass' },
    } as unknown as ExecutionInstance['steps'][number])
    await controller.publishForRun('ws_1', instance)
    expect(sections).toHaveLength(2)
  })

  it('never lets a publisher failure escape into the run', async () => {
    const failing: PrVerificationReportPublisher = {
      publish: async () => {
        throw new Error('GitHub is down')
      },
    }
    const warnings: string[] = []
    await expect(
      new PrVerificationReportController({
        ...makeDeps(BLOCK, failing),
        logger: { warn: (_obj, msg) => warnings.push(msg) },
      }).publishForRun('ws_1', makeInstance()),
    ).resolves.toBeUndefined()
    expect(warnings).toHaveLength(1)
  })

  it('builds the observability deep link from the configured app base URL', async () => {
    const { sections, publisher } = recordingPublisher()
    await new PrVerificationReportController({
      ...makeDeps(BLOCK, publisher),
      appBaseUrl: 'https://app.example.test/',
    }).publishForRun('ws_1', makeInstance())

    expect(sections[0]).toContain(
      'https://app.example.test/?ws=ws_1&block=blk_1&run=exec_1&view=observability',
    )
  })
})
