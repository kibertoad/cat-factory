import type {
  Block,
  BlockRepository,
  ExecutionInstance,
  PrVerificationReportPublisher,
  WorkspaceSettingsRepository,
} from '@cat-factory/kernel'
import { DEFAULT_WORKSPACE_SETTINGS } from '@cat-factory/kernel'
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
      resolveTarget: async () => ({ prNumber: 7, repo: 'acme/api', provider: 'github' as const }),
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

  it('skips when the adapter can resolve no pull request to publish onto', async () => {
    // Resolution is the ADAPTER's job (it owns "which PR / which repo"), so an unresolvable
    // block must short-circuit the hook before anything is composed.
    const sections: string[] = []
    let blockReads = 0
    const publisher: PrVerificationReportPublisher = {
      resolveTarget: async () => null,
      publish: async (_ws, _block, section) => {
        sections.push(section)
        return { published: true }
      },
    }
    await new PrVerificationReportController({
      blockRepository: {
        get: async () => {
          blockReads += 1
          return BLOCK
        },
      } as unknown as BlockRepository,
      clock: { now: () => 0 },
      publisher,
    }).publishForRun('ws_1', makeInstance())
    expect(sections).toHaveLength(0)
    expect(blockReads).toBe(0)
  })

  it("states the repo and provider the ADAPTER resolved, not the run's last dispatch", async () => {
    // A multi-repo run's last dispatch is a PEER repo; the report must name the repo whose PR
    // it is actually written onto.
    const sections: string[] = []
    const publisher: PrVerificationReportPublisher = {
      resolveTarget: async () => ({ prNumber: 7, repo: 'acme/api', provider: 'gitlab' }),
      publish: async (_ws, _block, section) => {
        sections.push(section)
        return { published: true }
      },
    }
    const instance = makeInstance({
      diagnostics: { lastDispatch: { repo: { owner: 'acme', name: 'peer-lib' } } },
    } as unknown as Partial<ExecutionInstance>)
    await new PrVerificationReportController({
      ...makeDeps(BLOCK, publisher),
    }).publishForRun('ws_1', instance)
    expect(sections[0]).toContain('acme/api (gitlab)')
    expect(sections[0]).not.toContain('peer-lib')
  })

  it('does not publish when the workspace turned the report off', async () => {
    const { sections, publisher } = recordingPublisher()
    await new PrVerificationReportController({
      ...makeDeps(BLOCK, publisher),
      workspaceSettingsRepository: {
        get: async () => ({ ...DEFAULT_WORKSPACE_SETTINGS, publishPrVerificationReport: false }),
      } as unknown as WorkspaceSettingsRepository,
    }).publishForRun('ws_1', makeInstance())
    expect(sections).toHaveLength(0)
  })

  it('skips the remote write when the report has not changed', async () => {
    const { sections, publisher } = recordingPublisher()
    const controller = new PrVerificationReportController(makeDeps(BLOCK, publisher))
    const instance = makeInstance()
    await controller.publishForRun('ws_1', instance)
    await controller.publishForRun('ws_1', instance)
    // The second pass composes an identical report (only `generatedAt` could differ, and it is
    // masked out of the fingerprint), so a repeated settlement costs no PR edit.
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
      resolveTarget: async () => ({ prNumber: 7, repo: 'acme/api', provider: 'github' }),
      publish: async () => {
        throw new Error('GitHub is down')
      },
    }
    const warnings: string[] = []
    await expect(
      new PrVerificationReportController({
        ...makeDeps(BLOCK, failing),
        logger: { warn: (_obj, msg) => warnings.push(msg ?? '') },
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
