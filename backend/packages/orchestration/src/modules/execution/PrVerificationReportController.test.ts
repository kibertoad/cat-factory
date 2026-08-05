import type {
  Block,
  BlockRepository,
  ExecutionInstance,
  PrReportTarget,
  PrVerificationReportPublisher,
  WorkspaceSettingsRepository,
} from '@cat-factory/kernel'
import { DEFAULT_WORKSPACE_SETTINGS } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { PrVerificationReportController } from './PrVerificationReportController.js'
import { createRecordingLogger } from '@cat-factory/kernel'

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
    pipelineId: 'pl_simple',
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
      resolveTargets: async () => [
        { prNumber: 7, repo: 'acme/api', provider: 'github' as const, role: 'own' as const },
      ],
      publish: async (_ws: string, _block: string, _target: PrReportTarget, section: string) => {
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
      resolveTargets: async () => [],
      publish: async (_ws, _block, _target, section) => {
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
      resolveTargets: async () => [
        { prNumber: 7, repo: 'acme/api', provider: 'gitlab', role: 'own' },
      ],
      publish: async (_ws, _block, _target, section) => {
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
      resolveTargets: async () => [
        { prNumber: 7, repo: 'acme/api', provider: 'github', role: 'own' },
      ],
      publish: async () => {
        throw new Error('GitHub is down')
      },
    }
    const logger = createRecordingLogger()
    await expect(
      new PrVerificationReportController({
        ...makeDeps(BLOCK, failing),
        logger,
      }).publishForRun('ws_1', makeInstance()),
    ).resolves.toBeUndefined()
    expect(logger.lines.filter((l) => l.level === 'warn')).toHaveLength(1)
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
  it('links the auditable trajectory and the live report from the configured API base URL', async () => {
    const { sections, publisher } = recordingPublisher()
    await new PrVerificationReportController({
      ...makeDeps(BLOCK, publisher),
      apiBaseUrl: 'https://api.example.test/',
    }).publishForRun('ws_1', makeInstance())

    // Both links are built from the BACKEND url, never the SPA one beside it: they answer a
    // different question (bytes to anything holding a key vs a panel a human browses) and are
    // different hosts the moment the SPA is served separately.
    expect(sections[0]).toContain(
      'https://api.example.test/api/v1/debug/runs/exec_1/tool-calls?order=trajectory',
    )
    expect(sections[0]).toContain('https://api.example.test/api/v1/runs/exec_1/report')
  })

  it('emits no evidence links at all when no public backend URL is configured', async () => {
    const { sections, publisher } = recordingPublisher()
    await new PrVerificationReportController(makeDeps(BLOCK, publisher)).publishForRun(
      'ws_1',
      makeInstance(),
    )
    // A link to nowhere is worse than none, so the fields are null and the prose omits the rows.
    expect(sections[0]).not.toContain('order=trajectory')
    expect(sections[0]).toContain('"trajectoryUrl": null')
  })

  it('composes the report for a READ even when the run has no pull request', async () => {
    // The publish path short-circuits here (nowhere to write); the read path must not, because a
    // headless job and a run that failed before it pushed are exactly what a consumer asks about.
    const publisher = {
      resolveTargets: async () => [],
      publish: async () => ({ published: false as const }),
    } satisfies PrVerificationReportPublisher
    const report = await new PrVerificationReportController({
      ...makeDeps(BLOCK, publisher),
      apiBaseUrl: 'https://api.example.test',
    }).composeForRun('ws_1', makeInstance())

    expect(report?.run.executionId).toBe('exec_1')
    // Nothing resolved a repo, and the report says null rather than inventing one.
    expect(report?.run.repo).toBeNull()
    expect(report?.observability.reportUrl).toBe(
      'https://api.example.test/api/v1/runs/exec_1/report',
    )
  })

  it('composes nothing for a run whose block is gone', async () => {
    const controller = new PrVerificationReportController(makeDeps(null))
    await expect(controller.composeForRun('ws_1', makeInstance())).resolves.toBeNull()
  })

  it('composes for a READ even when the workspace turned PUBLISHING off', async () => {
    // The opt-out is a statement about writing onto someone's pull request, not about whether the
    // workspace may read its own evidence back over an authenticated, workspace-scoped key.
    const settings = {
      get: async () => ({ ...DEFAULT_WORKSPACE_SETTINGS, publishPrVerificationReport: false }),
    } as unknown as WorkspaceSettingsRepository
    const { sections, publisher } = recordingPublisher()
    const controller = new PrVerificationReportController({
      ...makeDeps(BLOCK, publisher),
      workspaceSettingsRepository: settings,
    })

    await controller.publishForRun('ws_1', makeInstance())
    expect(sections).toHaveLength(0)
    await expect(controller.composeForRun('ws_1', makeInstance())).resolves.not.toBeNull()
  })
})
