import { describe, expect, it } from 'vitest'
import { createRecordingLogger } from '@cat-factory/kernel'
import type {
  Block,
  EnvironmentHandle,
  EnvironmentProbeAgent,
  EnvironmentProbeRequest,
  EnvironmentProbeUpdate,
  EnvironmentTestRunRecord,
  RunRepoContext,
} from '@cat-factory/kernel'
import { EnvironmentProbeStage } from './environmentProbeStage.js'

// The `probing` stage's own half of the dry run: what it puts in front of the prober, and what it
// does with the reply. Three of these cover things NOTHING else can:
//
//   - the report is model-authored text on its way to a persisted row and a rendered panel, and the
//     prompt hands the agent the environment's own credential verbatim. The scrub is the boundary;
//     the prompt asking the model not to echo a token is guidance;
//   - a BROKEN dry run has to say which way it broke. The run record has one error field, so a
//     container that vanished and a model that errored otherwise read identically to the developer
//     deciding whether pressing the button again is worth anything;
//   - the frame is read ONCE per tick. Two reads a moment apart can observe two different frames,
//     so a rename between them names a service in the prompt that does not match the surface the
//     claim pinned.

const FRAME: Block = {
  id: 'frame-1',
  workspaceId: 'ws',
  level: 'frame',
  type: 'service',
  title: 'Grass API',
  description: 'Serves grass to lawns.',
} as unknown as Block

const HANDLE: EnvironmentHandle = {
  id: 'env-1',
  url: 'https://pr-1.acme.test',
  status: 'ready',
  access: { scheme: 'bearer', token: 'env-token' },
} as unknown as EnvironmentHandle

const RECORD: EnvironmentTestRunRecord = {
  id: 'envtest_1',
  workspaceId: 'ws',
  blockId: 'frame-1',
  mode: 'agent-probe',
  status: 'running',
  stage: 'probing',
  initiatedBy: 'usr_1',
  provisioning: { type: 'kubernetes' },
  branch: 'cat-factory/env-test/envtest_1',
  environmentId: 'env-1',
  envUrl: 'https://pr-1.acme.test',
  error: null,
  failedStage: null,
  probeSurface: null,
  probeDispatchedAt: null,
  probeProgress: null,
  probe: null,
  createdAt: 1,
  updatedAt: 1,
}

function makeStage(over: { update?: EnvironmentProbeUpdate; frame?: Block | null } = {}) {
  const started: EnvironmentProbeRequest[] = []
  let frameReads = 0
  const agent: EnvironmentProbeAgent = {
    supports: async () => true,
    start: async (request) => {
      started.push(request)
      return {
        workspaceId: request.workspaceId,
        jobId: request.jobId,
        surface: request.surface,
        blockId: request.blockId,
        initiatedBy: request.initiatedBy,
      }
    },
    poll: async () => over.update ?? { state: 'running' },
    stop: async () => {},
  }
  const logger = createRecordingLogger()
  const stage = new EnvironmentProbeStage({
    agent,
    blockRepository: {
      get: async () => {
        frameReads += 1
        return over.frame === undefined ? FRAME : over.frame
      },
    } as never,
    environments: { getHandleWithAccess: async () => HANDLE },
    resolveRunRepoContext: async () =>
      ({ owner: 'kibertoad', name: 'acme', baseBranch: 'main' }) as unknown as RunRepoContext,
    logger,
  })
  return { stage, started, logs: logger.lines, frameReads: () => frameReads }
}

describe('EnvironmentProbeStage: what it hands the prober', () => {
  it('reads the frame ONCE and picks the surface from its type', async () => {
    const { stage, frameReads } = makeStage()
    const target = await stage.resolveTarget(RECORD)
    expect(target.surface).toBe('api')
    expect(target.frame.title).toBe('Grass API')
    expect(frameReads()).toBe(1)

    // The dispatch takes the frame it was GIVEN: a second read here is a second chance to observe
    // a different frame than the one the surface was derived from.
    await stage.dispatch(RECORD, target.surface, target.frame)
    expect(frameReads()).toBe(1)
  })

  it('drives a frontend frame in a browser', async () => {
    const { stage } = makeStage({ frame: { ...FRAME, type: 'frontend' } as Block })
    expect((await stage.resolveTarget(RECORD)).surface).toBe('ui')
  })

  it('names the deleted frame rather than what it could not find', async () => {
    const { stage } = makeStage({ frame: null })
    await expect(stage.resolveTarget(RECORD)).rejects.toThrow(/service frame was deleted/i)
  })

  it('dispatches against the THROWAWAY branch and the live environment', async () => {
    const { stage, started } = makeStage()
    await stage.dispatch(RECORD, 'api', FRAME)
    expect(started[0]).toMatchObject({
      jobId: 'envtest_1',
      blockId: 'frame-1',
      surface: 'api',
      repo: { owner: 'kibertoad', name: 'acme', branch: 'cat-factory/env-test/envtest_1' },
      environment: { url: 'https://pr-1.acme.test' },
      service: { title: 'Grass API', description: 'Serves grass to lawns.' },
      initiatedBy: 'usr_1',
    })
  })
})

describe('EnvironmentProbeStage: what it does with the reply', () => {
  it('SCRUBS the model-authored report before it is persisted or rendered', async () => {
    // The prompt inlines `Authorization: Bearer <token>` for the environment the platform just
    // provisioned, so a model pasting its own curl invocation into a `detail` writes that
    // credential into `environment_test_runs.probe` and into the inspector panel.
    const { stage } = makeStage({
      update: {
        state: 'done',
        model: 'workers-ai:qwen',
        report: {
          summary: 'authenticated with sk-live-abcdefghijklmnopqrstuvwxyz012345',
          operations: [
            {
              name: 'list projects',
              authenticated: true,
              outcome: 'succeeded',
              detail:
                'curl -H "Authorization: Bearer sk-live-abcdefghijklmnopqrstuvwxyz012345" /projects',
            },
          ],
          missingContext: [],
          blockers: [],
        },
      },
    })
    const outcome = await stage.poll(RECORD, 'api')
    expect(outcome.state).toBe('reported')
    const serialized = JSON.stringify(outcome)
    expect(serialized).not.toContain('sk-live-abcdefghijklmnopqrstuvwxyz012345')
    // The surrounding context survives, so the report still says what was done.
    expect(serialized).toContain('list projects')
  })

  it('carries the live progress through, so the longest stage can push something', async () => {
    const { stage } = makeStage({
      update: { state: 'running', subtasks: { completed: 2, inProgress: 1, total: 5 } },
    })
    expect(await stage.poll(RECORD, 'api')).toEqual({
      state: 'running',
      subtasks: { completed: 2, inProgress: 1, total: 5 },
    })
  })

  it.each([
    ['evicted' as const, /vanished before it reported/i],
    ['harness_shutdown' as const, /shut down while the agent was still working/i],
    ['timeout' as const, /passed its watchdog/i],
    ['agent' as const, /failed before it produced a report/i],
  ])('states HOW a %s dry run broke, ahead of the container message', async (kind, matcher) => {
    const { stage } = makeStage({
      update: { state: 'failed', failureKind: kind, error: 'the container said this' },
    })
    const error = await stage.poll(RECORD, 'api').catch((e: unknown) => e)
    expect((error as Error).message).toMatch(matcher)
    // The container's own words are kept: they are the only thing that names the specific fault.
    expect((error as Error).message).toContain('the container said this')
  })

  it('throws rather than reporting a broken dry run as a verdict about the service', async () => {
    // An `inoperable` verdict is a completed diagnostic with a finding. A container that never
    // reported is the platform's own step breaking, and laundering it into a verdict would tell an
    // operator their service is unusable.
    const { stage } = makeStage({
      update: { state: 'failed', failureKind: 'evicted', error: 'gone' },
    })
    await expect(stage.poll(RECORD, 'api')).rejects.toThrow()
  })
})
